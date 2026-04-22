import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildToolText,
  extractGroundingData,
  formatDiagnostics,
  resolveModelId,
  validateAskGoogleArguments,
} from "../../src/tool.js";
import { parseEnabledModels, VALID_MODELS } from "../../src/config.js";
import { createAskGoogleHandler } from "../../src/ask-google.js";
import { retryWithBackoff } from "../../src/retry.js";
import { isPermanentFinishReason, classifyGeminiError } from "../../src/errors.js";

// Shared call counter across mock instances so retries see the next scripted step even
// when the handler creates a fresh model per attempt (required for fallback model support).
class MockGenerativeModel {
  constructor(state, config) {
    this.state = state;
    this.config = config;
  }

  async generateContentStream(question, { signal } = {}) {
    const index = this.state.callCount;
    this.state.callCount += 1;
    const script = this.state.script || [];
    const step = script[index] ?? this.state.defaultStep ?? { text: "ok" };

    if (signal?.aborted) {
      throw new Error("Aborted before stream started");
    }

    if (step.preStreamDelayMs) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, step.preStreamDelayMs);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("Aborted"));
          },
          { once: true }
        );
      });
    }

    if (step.throw) {
      throw new Error(step.throw);
    }

    // Default chunk: append the question to the text so handler assertions can verify
    // the question was plumbed through to the model, matching the original mock's behavior.
    const defaultChunk =
      step.text !== undefined && step.text !== "" ? `${step.text} :: ${question}` : step.text ?? "";
    const chunks = step.chunks ?? (defaultChunk !== "" ? [defaultChunk] : []);
    const candidates = step.candidates ?? [
      { finishReason: step.finishReason ?? "STOP", groundingMetadata: step.groundingMetadata },
    ];
    const finalText = chunks.join("");

    const stream = (async function* () {
      for (let i = 0; i < chunks.length; i += 1) {
        if (i === 0 && step.firstChunkDelayMs) {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, step.firstChunkDelayMs);
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(new Error("Aborted"));
              },
              { once: true }
            );
          });
        }
        if (i > 0 && step.interChunkDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, step.interChunkDelayMs));
        }
        const chunkText = chunks[i];
        yield { text: () => chunkText };
      }
    })();

    return {
      stream,
      response: Promise.resolve({
        text: () => finalText,
        candidates,
      }),
    };
  }
}

function createHandler(options = {}) {
  const planState = {
    script: options.plan?.script,
    defaultStep: options.plan?.defaultStep ?? { text: "ok" },
    callCount: 0,
  };
  const createdModels = [];
  const logger = options.logger || { error: () => {} };

  const handler = createAskGoogleHandler({
    logger,
    systemPromptTemplate: "Current date: {{CURRENT_DATE}}",
    overallBudgetMs: options.overallBudgetMs ?? 5_000,
    modelTimeoutsMs: options.modelTimeoutsMs ?? { pro: 1_000, flash: 500, "flash-lite": 300 },
    modelTtftTimeoutsMs: options.modelTtftTimeoutsMs ?? { pro: 500, flash: 300, "flash-lite": 200 },
    fallbackModel: options.fallbackModel ?? "flash",
    requestTimeoutMs: options.requestTimeoutMs,
    maxRetries: options.maxRetries ?? 2,
    initialRetryDelayMs: options.initialRetryDelayMs ?? 1,
    minAttemptBudgetMs: options.minAttemptBudgetMs,
    fileOutputEnabled: options.fileOutputEnabled ?? false,
    fileOutputBaseDir: options.fileOutputBaseDir,
    getApiKey: options.getApiKey || (() => "test-api-key"),
    createClient: () => ({
      getGenerativeModel: (config) => {
        const model = new MockGenerativeModel(planState, config);
        createdModels.push({ config, model });
        return model;
      },
    }),
  });

  return { handler, createdModels, planState };
}

describe("parseEnabledModels", () => {
  it("returns all models when the env value is undefined", () => {
    const result = parseEnabledModels(undefined, VALID_MODELS);
    assert.deepStrictEqual(result.enabled, [...VALID_MODELS]);
    assert.deepStrictEqual(result.unknown, []);
  });

  it("treats null and empty/whitespace values as unset", () => {
    for (const value of [null, "", "   "]) {
      const result = parseEnabledModels(value, VALID_MODELS);
      assert.deepStrictEqual(result.enabled, [...VALID_MODELS]);
      assert.deepStrictEqual(result.unknown, []);
    }
  });

  it("parses a single valid alias", () => {
    const result = parseEnabledModels("flash", VALID_MODELS);
    assert.deepStrictEqual(result.enabled, ["flash"]);
    assert.deepStrictEqual(result.unknown, []);
  });

  it("parses a comma-separated list preserving first-occurrence order", () => {
    const result = parseEnabledModels("flash, pro", VALID_MODELS);
    assert.deepStrictEqual(result.enabled, ["flash", "pro"]);
    assert.deepStrictEqual(result.unknown, []);
  });

  it("partitions unknown aliases away from valid ones", () => {
    const result = parseEnabledModels("flash,bogus", VALID_MODELS);
    assert.deepStrictEqual(result.enabled, ["flash"]);
    assert.deepStrictEqual(result.unknown, ["bogus"]);
  });

  it("reports all tokens as unknown when none match", () => {
    const result = parseEnabledModels("bogus,alsobad", VALID_MODELS);
    assert.deepStrictEqual(result.enabled, []);
    assert.deepStrictEqual(result.unknown, ["bogus", "alsobad"]);
  });

  it("deduplicates and drops blank tokens", () => {
    const result = parseEnabledModels("flash,,pro,flash", VALID_MODELS);
    assert.deepStrictEqual(result.enabled, ["flash", "pro"]);
    assert.deepStrictEqual(result.unknown, []);
  });

  it("is case-sensitive (uppercase tokens are unknown)", () => {
    const result = parseEnabledModels("FLASH", VALID_MODELS);
    assert.deepStrictEqual(result.enabled, []);
    assert.deepStrictEqual(result.unknown, ["FLASH"]);
  });
});

describe("validateAskGoogleArguments", () => {
  it("rejects missing question", () => {
    assert.throws(() => validateAskGoogleArguments({}), /Missing required parameter/);
  });

  it("rejects invalid types and values", () => {
    assert.throws(() => validateAskGoogleArguments({ question: 123 }), /Question must be a string/);
    assert.throws(() => validateAskGoogleArguments({ question: "   " }), /Question cannot be empty/);
    assert.throws(
      () => validateAskGoogleArguments({ question: "ok", output_file: 123 }),
      /output_file must be a string/
    );
    assert.throws(
      () => validateAskGoogleArguments({ question: "ok", model: "FLASH" }),
      /model must be one of/
    );
  });

  it("returns normalized arguments", () => {
    assert.deepStrictEqual(validateAskGoogleArguments({ question: "test" }), {
      question: "test",
      outputFile: undefined,
      model: "pro",
    });
  });

  it("accepts 'query' as an alias for 'question'", () => {
    assert.deepStrictEqual(validateAskGoogleArguments({ query: "test" }), {
      question: "test",
      outputFile: undefined,
      model: "pro",
    });
  });

  it("rejects providing both 'question' and 'query'", () => {
    assert.throws(
      () => validateAskGoogleArguments({ question: "a", query: "b" }),
      /Provide either 'question' or 'query'/
    );
  });

  it("applies the same validation rules to the 'query' alias", () => {
    assert.throws(() => validateAskGoogleArguments({ query: 123 }), /Question must be a string/);
    assert.throws(() => validateAskGoogleArguments({ query: "   " }), /Question cannot be empty/);
  });
});

describe("tool helpers", () => {
  it("maps model aliases to configured ids", () => {
    assert.match(resolveModelId("pro"), /gemini/);
    assert.match(resolveModelId("flash"), /gemini/);
  });

  it("deduplicates sources and caps metadata lists", () => {
    const { sources, searches } = extractGroundingData({
      candidates: [
        {
          groundingMetadata: {
            groundingChunks: [
              { web: { title: "One", uri: "https://example.com/1" } },
              { web: { title: "One dup", uri: "https://example.com/1" } },
              { web: { title: "Two", uri: "https://example.com/2" } },
            ],
            webSearchQueries: ["a", "b"],
          },
        },
      ],
    });

    assert.deepStrictEqual(
      sources.map((source) => source.url),
      ["https://example.com/1", "https://example.com/2"]
    );
    assert.deepStrictEqual(searches, ["a", "b"]);
  });

  it("formats appended metadata and notes", () => {
    const text = buildToolText("answer", {
      sources: [{ title: "Doc", url: "https://example.com" }],
      searches: ["query"],
      fileWriteError: "disk full",
    });

    assert.match(text, /\*\*Sources:\*\*/);
    assert.match(text, /Search queries performed/);
    assert.match(text, /disk full/);
  });

  it("renders a diagnostics footer when provided", () => {
    const text = buildToolText("answer", {
      diagnostics: {
        model: "pro",
        fellBack: false,
        attempts: 1,
        totalAttempts: 3,
        durationMs: 12_400,
        ttftMs: 4_200,
      },
    });

    assert.match(text, /_diagnostics: model=pro · attempts=1\/3 · duration=12\.4s · ttft=4\.2s_/);
  });

  it("marks fallback in diagnostics", () => {
    const out = formatDiagnostics({
      model: "flash",
      fellBack: true,
      attempts: 3,
      totalAttempts: 3,
      durationMs: 47_210,
    });
    assert.match(out, /model=flash \(fallback\)/);
    assert.match(out, /attempts=3\/3/);
    assert.match(out, /duration=47\.2s/);
  });
});

describe("isPermanentFinishReason", () => {
  it("flags model-side refusals as permanent", () => {
    for (const reason of ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "OTHER", "SPII"]) {
      assert.strictEqual(isPermanentFinishReason(reason), true, `${reason} should be permanent`);
    }
  });

  it("treats STOP and MAX_TOKENS and unknown as non-permanent", () => {
    for (const reason of ["STOP", "MAX_TOKENS", "UNSPECIFIED", undefined, null, "something-new"]) {
      assert.strictEqual(isPermanentFinishReason(reason), false);
    }
  });
});

describe("classifyGeminiError", () => {
  it("prefers finishReason classification when present", () => {
    const err = new Error("anything");
    err.finishReason = "SAFETY";
    assert.match(classifyGeminiError(err), /\[CONTENT_BLOCKED\]/);
  });

  it("maps TTFT stalls to STALL_ERROR", () => {
    assert.match(classifyGeminiError(new Error("[TTFT_TIMEOUT] stalled")), /\[STALL_ERROR\]/);
  });

  it("maps abort errors to TIMEOUT_ERROR", () => {
    assert.match(classifyGeminiError(new Error("aborted")), /\[TIMEOUT_ERROR\]/);
  });
});

describe("retryWithBackoff", () => {
  it("retries retryable failures and succeeds", async () => {
    let attempts = 0;
    const result = await retryWithBackoff(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("temporary network error");
        }
        return "ok";
      },
      {
        maxRetries: 3,
        initialDelayMs: 1,
        shouldRetry: () => true,
      }
    );

    assert.strictEqual(result, "ok");
    assert.strictEqual(attempts, 3);
  });

  it("stops on non-retryable failures", async () => {
    await assert.rejects(
      retryWithBackoff(
        async () => {
          throw new Error("quota exceeded");
        },
        {
          maxRetries: 3,
          initialDelayMs: 1,
          shouldRetry: () => false,
        }
      ),
      /quota exceeded/
    );
  });

  it("passes attempt, totalAttempts, and remainingBudgetMs to fn", async () => {
    const calls = [];
    await retryWithBackoff(
      async (ctx) => {
        calls.push(ctx);
        return "done";
      },
      {
        maxRetries: 2,
        initialDelayMs: 1,
        shouldRetry: () => true,
        overallBudgetMs: 10_000,
      }
    );

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].attempt, 1);
    assert.strictEqual(calls[0].totalAttempts, 3);
    assert.ok(calls[0].remainingBudgetMs > 9_000);
  });

  it("aborts before the next attempt if remaining budget is too small", async () => {
    let attempts = 0;
    await assert.rejects(
      retryWithBackoff(
        async () => {
          attempts += 1;
          throw new Error("transient");
        },
        {
          maxRetries: 5,
          initialDelayMs: 1,
          shouldRetry: () => true,
          overallBudgetMs: 1,
          minAttemptBudgetMs: 100,
        }
      )
    );
    // Because budget is below minAttemptBudgetMs from the start, we bail before the first attempt.
    assert.strictEqual(attempts, 0);
  });
});

describe("createAskGoogleHandler", () => {
  it("allows server startup without an API key but fails tool execution with auth error", async () => {
    const { handler } = createHandler({
      getApiKey: () => "",
    });

    await assert.rejects(handler({ question: "latest node" }), /\[AUTH_ERROR\]/);
  });

  it("uses the configured model id and system prompt", async () => {
    const { handler, createdModels } = createHandler();

    const result = await handler({ question: "latest node", model: "flash" });

    assert.match(result.content[0].text, /latest node/);
    assert.match(result.content[0].text, /_diagnostics: model=flash · attempts=1\/3/);
    assert.strictEqual(createdModels[0].config.model, resolveModelId("flash"));
    assert.match(createdModels[0].config.systemInstruction, /Current date:/);
  });

  it("accepts the 'query' alias end-to-end", async () => {
    const { handler } = createHandler();

    const result = await handler({ query: "alias works" });

    assert.match(result.content[0].text, /alias works/);
  });

  it("retries transient failures", async () => {
    const { handler } = createHandler({
      plan: {
        script: [
          { throw: "temporary upstream error" },
          { text: "ok" },
        ],
      },
    });

    const result = await handler({ question: "retry me" });
    assert.match(result.content[0].text, /retry me/);
  });

  it("retries when the stream hangs past TTFT and eventually succeeds", async () => {
    const { handler, createdModels } = createHandler({
      modelTimeoutsMs: { pro: 1_000, flash: 1_000, "flash-lite": 1_000 },
      modelTtftTimeoutsMs: { pro: 20, flash: 20, "flash-lite": 20 },
      plan: {
        script: [
          { firstChunkDelayMs: 200, chunks: ["never sent"] },
          { text: "recovered" },
        ],
      },
    });

    const result = await handler({ question: "stalled first try" });
    assert.match(result.content[0].text, /recovered/);
    assert.strictEqual(createdModels.length, 2);
  });

  it("fails fast without retry when finishReason is SAFETY", async () => {
    const { handler, createdModels } = createHandler({
      plan: {
        script: [
          { text: "", finishReason: "SAFETY" },
          // Second step exists but should never be used.
          { text: "should not see this" },
        ],
      },
    });

    await assert.rejects(handler({ question: "blocked" }), /\[CONTENT_BLOCKED\]/);
    assert.strictEqual(createdModels.length, 1);
  });

  it("falls back to the fallback model on the last attempt when user requested pro", async () => {
    const { handler, createdModels } = createHandler({
      maxRetries: 2,
      plan: {
        script: [
          { throw: "transient 1" },
          { throw: "transient 2" },
          { text: "rescued by fallback" },
        ],
      },
    });

    const result = await handler({ question: "fallback me", model: "pro" });
    assert.match(result.content[0].text, /rescued by fallback/);
    assert.match(result.content[0].text, /model=flash \(fallback\).*attempts=3\/3/);
    assert.strictEqual(createdModels.length, 3);
    assert.strictEqual(createdModels[0].config.model, resolveModelId("pro"));
    assert.strictEqual(createdModels[1].config.model, resolveModelId("pro"));
    assert.strictEqual(createdModels[2].config.model, resolveModelId("flash"));
  });

  it("does not downgrade when the user explicitly requested flash", async () => {
    const { handler, createdModels } = createHandler({
      maxRetries: 2,
      plan: {
        script: [
          { throw: "transient 1" },
          { throw: "transient 2" },
          { text: "stayed on flash" },
        ],
      },
    });

    const result = await handler({ question: "stay flash", model: "flash" });
    assert.match(result.content[0].text, /stayed on flash/);
    for (const created of createdModels) {
      assert.strictEqual(created.config.model, resolveModelId("flash"));
    }
  });

  it("surfaces timeout failures when no attempt completes in time", async () => {
    const { handler } = createHandler({
      overallBudgetMs: 500,
      minAttemptBudgetMs: 10,
      modelTimeoutsMs: { pro: 30, flash: 30, "flash-lite": 30 },
      modelTtftTimeoutsMs: { pro: 15, flash: 15, "flash-lite": 15 },
      maxRetries: 1,
      plan: {
        defaultStep: { preStreamDelayMs: 500, text: "too slow" },
      },
    });

    await assert.rejects(handler({ question: "slow" }), /\[(TIMEOUT_ERROR|STALL_ERROR|API_ERROR)\]/);
  });

  it("retries empty responses (no finishReason), treating them as transient", async () => {
    const { handler, createdModels } = createHandler({
      plan: {
        script: [
          { text: "", candidates: [{}] },
          { text: "got it" },
        ],
      },
    });

    const result = await handler({ question: "retry empty" });
    assert.match(result.content[0].text, /got it/);
    assert.strictEqual(createdModels.length, 2);
  });

  it("writes output only when explicitly enabled and confined to the base directory", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "ask-google-output-"));
    const outputPath = join(outputDir, "nested", "answer.md");
    const { handler } = createHandler({
      fileOutputEnabled: true,
      fileOutputBaseDir: outputDir,
    });

    try {
      await handler({ question: "save this", output_file: outputPath });
      assert.ok(existsSync(outputPath));
      assert.match(readFileSync(outputPath, "utf-8"), /save this/);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects output paths outside the configured base directory", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "ask-google-output-"));
    const { handler } = createHandler({
      fileOutputEnabled: true,
      fileOutputBaseDir: outputDir,
    });

    try {
      await assert.rejects(
        handler({ question: "nope", output_file: "/tmp/outside.md" }),
        /output_file must stay within/
      );
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects output_file when file output is disabled", async () => {
    const { handler } = createHandler({
      fileOutputEnabled: false,
      fileOutputBaseDir: process.cwd(),
    });

    await assert.rejects(
      handler({ question: "save this", output_file: "answer.md" }),
      /output_file is disabled/
    );
  });
});
