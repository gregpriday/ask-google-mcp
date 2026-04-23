import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { MODEL_ALIASES } from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Loaded once at module-load time; {{CURRENT_DATE}} and {{ENABLED_MODELS}} are substituted per call.
const DEFAULT_ROUTER_TEMPLATE = readFileSync(
  join(__dirname, "router-prompt.txt"),
  "utf-8"
);

// Gemini's native schema uses UPPERCASE type names. The SDK accepts string literals here, which
// keeps this file free of an otherwise-redundant `Type` enum import from @google/genai.
const ROUTER_SCHEMA = Object.freeze({
  type: "OBJECT",
  properties: {
    model: {
      type: "STRING",
      enum: ["pro", "flash", "flash-lite"],
    },
  },
  required: ["model"],
});

const SNAP_ORDER = ["pro", "flash", "flash-lite"];

export function buildRouterPrompt(template, now, enabledModels) {
  const date = now.toISOString().slice(0, 10);
  return template
    .replace("{{CURRENT_DATE}}", `${date} (UTC)`)
    .replace("{{ENABLED_MODELS}}", enabledModels.join(", "));
}

// Snap a router pick to the closest enabled tier without downgrading more than necessary.
// E.g., router said "pro" but pro is disabled → try flash, then flash-lite.
function snapToEnabled(picked, enabledModels) {
  const startIdx = SNAP_ORDER.indexOf(picked);
  if (startIdx === -1) return enabledModels[0];
  for (let i = startIdx; i < SNAP_ORDER.length; i += 1) {
    if (enabledModels.includes(SNAP_ORDER[i])) return SNAP_ORDER[i];
  }
  // No enabled model at-or-below the pick — walk up instead.
  for (let i = startIdx - 1; i >= 0; i -= 1) {
    if (enabledModels.includes(SNAP_ORDER[i])) return SNAP_ORDER[i];
  }
  return enabledModels[0];
}

// Creates a `routeQuery(question) → { model, durationMs, usedFallback, reason?, snappedFrom? }`
// function. The router NEVER throws — failures collapse to `usedFallback: true` with the configured
// fallback model. This keeps the main `ask_google` call path orthogonal to router reliability.
export function createRouter({
  getClient,
  logger = console,
  routerModelAlias,
  enabledModels,
  timeoutMs,
  fallbackModel,
  now = () => new Date(),
  systemPromptTemplate = DEFAULT_ROUTER_TEMPLATE,
} = {}) {
  if (!getClient) {
    throw new Error("createRouter: getClient is required");
  }
  if (!routerModelAlias) {
    throw new Error("createRouter: routerModelAlias is required");
  }
  if (!Array.isArray(enabledModels) || enabledModels.length === 0) {
    throw new Error("createRouter: enabledModels must be a non-empty array");
  }
  if (!fallbackModel) {
    throw new Error("createRouter: fallbackModel is required");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("createRouter: timeoutMs must be a positive number");
  }

  return async function routeQuery(question) {
    const start = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const safeFallback = (reason, error) => ({
      model: fallbackModel,
      durationMs: Date.now() - start,
      usedFallback: true,
      reason,
      error: error?.message,
    });

    try {
      const modelId = MODEL_ALIASES[routerModelAlias];
      if (!modelId) {
        clearTimeout(timeoutId);
        return safeFallback(`Unknown router model alias "${routerModelAlias}"`);
      }

      const client = getClient();
      const systemInstruction = buildRouterPrompt(
        systemPromptTemplate,
        now(),
        enabledModels
      );

      // Non-streaming call — the output is a single small JSON object, no need for chunked
      // delivery. MINIMAL thinking is the cheapest/fastest tier on flash-lite; a classifier
      // this tight doesn't need reasoning budget. temperature=0 makes the pick deterministic
      // for identical inputs; maxOutputTokens caps output at ~1 small JSON object so a
      // runaway response can't eat the router budget.
      const response = await client.models.generateContent({
        model: modelId,
        contents: question,
        config: {
          systemInstruction,
          responseMimeType: "application/json",
          responseSchema: ROUTER_SCHEMA,
          thinkingConfig: { thinkingLevel: "MINIMAL" },
          temperature: 0,
          maxOutputTokens: 64,
          abortSignal: controller.signal,
        },
      });

      clearTimeout(timeoutId);

      const text =
        typeof response?.text === "string"
          ? response.text
          : response?.candidates?.[0]?.content?.parts
              ?.map((p) => p?.text)
              .filter((t) => typeof t === "string")
              .join("") ?? "";

      if (!text || text.trim().length === 0) {
        return safeFallback("Router returned empty response");
      }

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        return safeFallback("Router returned non-JSON output", error);
      }

      const picked = parsed?.model;
      if (picked !== "pro" && picked !== "flash" && picked !== "flash-lite") {
        return safeFallback(`Router picked invalid model "${picked}"`);
      }

      if (!enabledModels.includes(picked)) {
        const snapped = snapToEnabled(picked, enabledModels);
        logger.error(
          `[ROUTER] picked disabled model "${picked}"; snapped to "${snapped}"`
        );
        return {
          model: snapped,
          durationMs: Date.now() - start,
          usedFallback: false,
          snappedFrom: picked,
        };
      }

      return {
        model: picked,
        durationMs: Date.now() - start,
        usedFallback: false,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      const isAbort =
        error?.name === "AbortError" || /abort/i.test(error?.message || "");
      return safeFallback(
        isAbort ? `Router timed out after ${timeoutMs}ms` : "Router call failed",
        error
      );
    }
  };
}
