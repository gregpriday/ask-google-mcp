import { describe, it } from "node:test";
import assert from "node:assert";
import { buildRouterPrompt, createRouter } from "../../src/router.js";
import { createAskGoogleHandler } from "../../src/ask-google.js";

const NOW = () => new Date("2026-04-23T10:00:00Z");

function makeMockClient({ respond, throws, delayMs }) {
  return {
    models: {
      async generateContent(params) {
        const signal = params?.config?.abortSignal;
        if (delayMs) {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, delayMs);
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
              },
              { once: true }
            );
          });
        }
        if (throws) {
          throw throws;
        }
        return {
          text: typeof respond === "string" ? respond : JSON.stringify(respond),
        };
      },
      // Minimum shape so the downstream `ask_google` call doesn't accidentally blow up if it
      // somehow reaches this mock (shouldn't in router-only tests).
      generateContentStream: async () => ({
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return { done: true, value: undefined };
            },
          };
        },
      }),
    },
  };
}

describe("buildRouterPrompt", () => {
  it("substitutes CURRENT_DATE and ENABLED_MODELS", () => {
    const template = "Date: {{CURRENT_DATE}}\nModels: {{ENABLED_MODELS}}";
    const out = buildRouterPrompt(template, new Date("2026-04-23T00:00:00Z"), [
      "pro",
      "flash",
      "flash-lite",
    ]);
    assert.match(out, /Date: 2026-04-23 \(UTC\)/);
    assert.match(out, /Models: pro, flash, flash-lite/);
  });
});

describe("createRouter", () => {
  it("throws when required deps are missing", () => {
    assert.throws(() => createRouter({}), /getClient is required/);
    assert.throws(
      () => createRouter({ getClient: () => ({}) }),
      /routerModelAlias is required/
    );
    assert.throws(
      () =>
        createRouter({
          getClient: () => ({}),
          routerModelAlias: "flash-lite",
        }),
      /enabledModels must be a non-empty array/
    );
  });

  it("picks the model returned by the classifier", async () => {
    const client = makeMockClient({ respond: { model: "pro" } });
    const route = createRouter({
      getClient: () => client,
      routerModelAlias: "flash-lite",
      enabledModels: ["pro", "flash", "flash-lite"],
      timeoutMs: 1_000,
      fallbackModel: "flash",
      now: NOW,
    });

    const result = await route("Should I migrate to Postgres?");
    assert.strictEqual(result.model, "pro");
    assert.strictEqual(result.usedFallback, false);
    assert.ok(result.durationMs >= 0);
  });

  it("falls back to flash when the router times out", async () => {
    const client = makeMockClient({ respond: { model: "pro" }, delayMs: 200 });
    const route = createRouter({
      getClient: () => client,
      routerModelAlias: "flash-lite",
      enabledModels: ["pro", "flash", "flash-lite"],
      timeoutMs: 20,
      fallbackModel: "flash",
      now: NOW,
    });

    const result = await route("anything");
    assert.strictEqual(result.model, "flash");
    assert.strictEqual(result.usedFallback, true);
    assert.match(result.reason, /timed out/i);
  });

  it("falls back when the classifier throws", async () => {
    const client = makeMockClient({ throws: new Error("nope") });
    const route = createRouter({
      getClient: () => client,
      routerModelAlias: "flash-lite",
      enabledModels: ["pro", "flash", "flash-lite"],
      timeoutMs: 1_000,
      fallbackModel: "flash",
      now: NOW,
    });

    const result = await route("anything");
    assert.strictEqual(result.model, "flash");
    assert.strictEqual(result.usedFallback, true);
    assert.strictEqual(result.error, "nope");
  });

  it("falls back when the response is empty", async () => {
    const client = makeMockClient({ respond: "" });
    const route = createRouter({
      getClient: () => client,
      routerModelAlias: "flash-lite",
      enabledModels: ["pro", "flash", "flash-lite"],
      timeoutMs: 1_000,
      fallbackModel: "flash",
      now: NOW,
    });

    const result = await route("anything");
    assert.strictEqual(result.model, "flash");
    assert.match(result.reason, /empty/i);
  });

  it("falls back when the response is not valid JSON", async () => {
    const client = makeMockClient({ respond: "not json" });
    const route = createRouter({
      getClient: () => client,
      routerModelAlias: "flash-lite",
      enabledModels: ["pro", "flash", "flash-lite"],
      timeoutMs: 1_000,
      fallbackModel: "flash",
      now: NOW,
    });

    const result = await route("anything");
    assert.strictEqual(result.model, "flash");
    assert.match(result.reason, /non-JSON/i);
  });

  it("falls back when the picked model is not one of the allowed enum values", async () => {
    const client = makeMockClient({ respond: { model: "ultra-pro" } });
    const route = createRouter({
      getClient: () => client,
      routerModelAlias: "flash-lite",
      enabledModels: ["pro", "flash", "flash-lite"],
      timeoutMs: 1_000,
      fallbackModel: "flash",
      now: NOW,
    });

    const result = await route("anything");
    assert.strictEqual(result.model, "flash");
    assert.match(result.reason, /invalid model/i);
  });

  it("snaps a valid pick to an enabled tier when the picked model is disabled", async () => {
    const client = makeMockClient({ respond: { model: "pro" } });
    const route = createRouter({
      getClient: () => client,
      routerModelAlias: "flash",
      enabledModels: ["flash", "flash-lite"], // pro disabled
      timeoutMs: 1_000,
      fallbackModel: "flash",
      now: NOW,
    });

    const result = await route("anything");
    assert.strictEqual(result.model, "flash"); // snapped down from pro → flash
    assert.strictEqual(result.snappedFrom, "pro");
    assert.strictEqual(result.usedFallback, false);
  });

  it("passes the router's system prompt and tight thinking config", async () => {
    const captured = {};
    const client = {
      models: {
        async generateContent(params) {
          captured.model = params.model;
          captured.config = params.config;
          return { text: JSON.stringify({ model: "flash-lite" }) };
        },
        generateContentStream: async () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true }) }) }),
      },
    };
    const route = createRouter({
      getClient: () => client,
      routerModelAlias: "flash-lite",
      enabledModels: ["pro", "flash", "flash-lite"],
      timeoutMs: 1_000,
      fallbackModel: "flash",
      now: NOW,
      systemPromptTemplate: "System date={{CURRENT_DATE}} models={{ENABLED_MODELS}}",
    });

    await route("latest node?");
    assert.match(captured.config.systemInstruction, /date=2026-04-23 \(UTC\)/);
    assert.match(captured.config.systemInstruction, /models=pro, flash, flash-lite/);
    assert.strictEqual(captured.config.responseMimeType, "application/json");
    assert.deepStrictEqual(captured.config.thinkingConfig, { thinkingLevel: "MINIMAL" });
  });
});

describe("createAskGoogleHandler with router", () => {
  function createHandler({ router, routerEnabled, routerFallbackModel, createClient, plan } = {}) {
    const planState = {
      script: plan?.script,
      defaultStep: plan?.defaultStep ?? { text: "downstream ok" },
      callCount: 0,
    };
    const createdModels = [];

    const defaultCreateClient = () => ({
      models: {
        async generateContentStream(params) {
          const step = planState.script?.[planState.callCount] ?? planState.defaultStep;
          planState.callCount += 1;
          createdModels.push({ config: { model: params.model } });
          const text =
            typeof step.text === "string" ? step.text : JSON.stringify(step);
          return (async function* () {
            yield { text, candidates: [{ finishReason: "STOP" }] };
          })();
        },
      },
    });

    const handler = createAskGoogleHandler({
      logger: { error: () => {} },
      systemPromptTemplate: "Current date: {{CURRENT_DATE}}",
      overallBudgetMs: 5_000,
      modelTimeoutsMs: { pro: 1_000, flash: 500, "flash-lite": 300 },
      modelTtftTimeoutsMs: { pro: 500, flash: 300, "flash-lite": 200 },
      modelInactivityTimeoutsMs: { pro: 500, flash: 300, "flash-lite": 200 },
      maxRetries: 0,
      initialRetryDelayMs: 1,
      getApiKey: () => "test-key",
      createClient: createClient ?? defaultCreateClient,
      router,
      routerEnabled,
      routerFallbackModel,
    });

    return { handler, createdModels };
  }

  it("invokes the router when model === 'auto' and honors its pick", async () => {
    let routerCalls = 0;
    const { handler, createdModels } = createHandler({
      router: async (question) => {
        routerCalls += 1;
        assert.strictEqual(question, "should I migrate to Postgres?");
        return { model: "pro", durationMs: 42, usedFallback: false };
      },
    });

    const result = await handler({
      question: "should I migrate to Postgres?",
      model: "auto",
    });

    assert.strictEqual(routerCalls, 1);
    assert.match(createdModels[0].config.model, /pro/);
    assert.strictEqual(result.structuredContent.diagnostics.requested_model, "auto");
    assert.strictEqual(result.structuredContent.diagnostics.model, "pro");
    assert.strictEqual(result.structuredContent.diagnostics.router.picked_model, "pro");
    assert.strictEqual(result.structuredContent.diagnostics.router.used_fallback, false);
    assert.match(result.content[0].text, /model=auto→pro/);
  });

  it("skips the router when the caller pins an explicit model", async () => {
    let routerCalls = 0;
    const { handler, createdModels } = createHandler({
      router: async () => {
        routerCalls += 1;
        return { model: "pro", durationMs: 0, usedFallback: false };
      },
    });

    await handler({ question: "anything", model: "flash" });
    assert.strictEqual(routerCalls, 0);
    assert.match(createdModels[0].config.model, /flash/);
  });

  it("surfaces router fallback metadata when the router returns usedFallback: true", async () => {
    const { handler } = createHandler({
      router: async () => ({
        model: "flash",
        durationMs: 123,
        usedFallback: true,
        reason: "Router timed out after 5000ms",
      }),
    });

    const result = await handler({ question: "something", model: "auto" });
    const diag = result.structuredContent.diagnostics;
    assert.strictEqual(diag.model, "flash");
    assert.strictEqual(diag.router.used_fallback, true);
    assert.match(diag.router.reason, /timed out/i);
    assert.match(result.content[0].text, /router=0\.1s\/fallback/);
  });

  it("uses the static router-fallback model when no router is available and model === 'auto'", async () => {
    const { handler, createdModels } = createHandler({
      router: null,
      routerEnabled: false,
      routerFallbackModel: "flash",
    });

    const result = await handler({ question: "no router", model: "auto" });
    assert.match(createdModels[0].config.model, /flash/);
    assert.strictEqual(result.structuredContent.diagnostics.router.used_fallback, true);
    assert.match(result.structuredContent.diagnostics.router.reason, /not available/i);
  });

  it("emits a progress notification announcing the routing decision", async () => {
    const notifications = [];
    const { handler } = createHandler({
      router: async () => ({ model: "pro", durationMs: 7, usedFallback: false }),
    });

    await handler(
      { question: "what to pick", model: "auto" },
      { notifyProgress: (p) => notifications.push(p) }
    );

    const routingMsg = notifications.find((n) => /Routed to pro/.test(n.message));
    assert.ok(routingMsg, "expected a 'Routed to pro' progress notification");
  });

  it("subtracts router latency from the overall budget passed to retryWithBackoff", async () => {
    // Strategy: set overallBudget=200ms, router reports durationMs=180ms, minAttemptBudget=50ms.
    // With the fix: retry receives budget 200-180=20ms, which is < minAttemptBudget=50ms, so
    // the retry loop bails out BEFORE running the first attempt and the downstream stream call
    // is never made.
    // Without the fix: retry gets the full 200ms, the attempt runs, and the stream call fires.
    let streamCalls = 0;

    const createClient = () => ({
      models: {
        async generateContentStream() {
          streamCalls += 1;
          return (async function* () {
            yield { text: "shouldn't reach here", candidates: [{ finishReason: "STOP" }] };
          })();
        },
      },
    });

    const handler = createAskGoogleHandler({
      logger: { error: () => {} },
      systemPromptTemplate: "Current date: {{CURRENT_DATE}}",
      overallBudgetMs: 200,
      modelTimeoutsMs: { pro: 1_000, flash: 1_000, "flash-lite": 1_000 },
      modelTtftTimeoutsMs: { pro: 500, flash: 500, "flash-lite": 500 },
      modelInactivityTimeoutsMs: { pro: 500, flash: 500, "flash-lite": 500 },
      minAttemptBudgetMs: 50,
      maxRetries: 0,
      initialRetryDelayMs: 1,
      getApiKey: () => "test-key",
      createClient,
      router: async () => ({
        model: "flash-lite",
        durationMs: 180,
        usedFallback: false,
      }),
    });

    const result = await handler({ question: "budget check", model: "auto" });
    // Key assertion: the retry loop bailed out before dispatching a stream call because the
    // router's reported latency consumed most of the configured overall budget.
    assert.strictEqual(
      streamCalls,
      0,
      "main stream call should not run when router latency consumes the budget"
    );
    assert.strictEqual(result.isError, true);
  });

  it("honors ROUTER_FALLBACK_MODEL snap-to-enabled when the env value isn't in ENABLED_MODELS", async () => {
    // Smoke test against the real config module: we can't easily override env vars mid-run,
    // but we can verify the live config's fallback is snapped to an enabled model and is
    // never the literal invalid string. This guards against regressions in the validation
    // cascade where an invalid env value short-circuits to "flash" before ENABLED_MODELS is
    // checked.
    const { ROUTER_FALLBACK_MODEL, ENABLED_MODELS: EM } = await import("../../src/config.js");
    assert.ok(EM.includes(ROUTER_FALLBACK_MODEL), `ROUTER_FALLBACK_MODEL "${ROUTER_FALLBACK_MODEL}" should be in ENABLED_MODELS (${EM.join(", ")})`);
  });
});
