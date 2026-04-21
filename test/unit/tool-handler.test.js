import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildToolText,
  extractGroundingData,
  resolveModelId,
  validateAskGoogleArguments,
} from "../../src/tool.js";
import { parseEnabledModels, VALID_MODELS } from "../../src/config.js";
import { createAskGoogleHandler } from "../../src/ask-google.js";
import { retryWithBackoff } from "../../src/retry.js";

class MockGenerativeModel {
  constructor(responsePlan) {
    this.responsePlan = responsePlan;
    this.callCount = 0;
  }

  async generateContent(question) {
    this.callCount += 1;

    if (this.responsePlan.failUntilAttempt && this.callCount < this.responsePlan.failUntilAttempt) {
      throw new Error(this.responsePlan.error || "Transient error");
    }

    if (this.responsePlan.shouldThrow) {
      throw new Error(this.responsePlan.error || "Boom");
    }

    return {
      response: {
        text: () => `${this.responsePlan.text} :: ${question}`,
        candidates: this.responsePlan.candidates || [],
      },
    };
  }
}

function createHandler(options = {}) {
  const responsePlan = options.responsePlan || { text: "ok" };
  const createdModels = [];
  const logger = {
    error: () => {},
  };

  const handler = createAskGoogleHandler({
    logger,
    systemPromptTemplate: "Current date: {{CURRENT_DATE}}",
    requestTimeoutMs: options.requestTimeoutMs || 250,
    maxRetries: options.maxRetries ?? 2,
    initialRetryDelayMs: 1,
    fileOutputEnabled: options.fileOutputEnabled ?? false,
    fileOutputBaseDir: options.fileOutputBaseDir,
    getApiKey: options.getApiKey || (() => "test-api-key"),
    createClient: () => ({
      getGenerativeModel: (config) => {
        const model = new MockGenerativeModel(responsePlan);
        createdModels.push({ config, model });
        return model;
      },
    }),
  });

  return { handler, createdModels };
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
    assert.strictEqual(createdModels[0].config.model, resolveModelId("flash"));
    assert.match(createdModels[0].config.systemInstruction, /Current date:/);
  });

  it("retries transient failures", async () => {
    const { handler } = createHandler({
      responsePlan: {
        text: "ok",
        failUntilAttempt: 2,
        error: "temporary upstream error",
      },
    });

    const result = await handler({ question: "retry me" });
    assert.match(result.content[0].text, /retry me/);
  });

  it("surfaces timeout failures", async () => {
    const { handler } = createHandler({
      requestTimeoutMs: 5,
      maxRetries: 0,
      responsePlan: {
        text: "never",
      },
    });

    const slowHandler = createAskGoogleHandler({
      logger: { error: () => {} },
      systemPromptTemplate: "Current date: {{CURRENT_DATE}}",
      requestTimeoutMs: 5,
      maxRetries: 0,
      initialRetryDelayMs: 1,
      fileOutputEnabled: false,
      getApiKey: () => "test-api-key",
      createClient: () => ({
        getGenerativeModel: () => ({
          async generateContent() {
            await new Promise((resolve) => setTimeout(resolve, 25));
            return { response: { text: () => "late", candidates: [] } };
          },
        }),
      }),
    });

    await assert.rejects(slowHandler({ question: "slow" }), /\[TIMEOUT_ERROR\]/);
    assert.ok(handler);
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
