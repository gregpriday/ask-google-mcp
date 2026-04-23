import { config as dotenvConfig } from "dotenv";
import { readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load the working directory .env first, then fall back to ~/.env.
dotenvConfig({ path: join(process.cwd(), ".env") });
dotenvConfig({ path: join(homedir(), ".env") });

export const packageJson = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8")
);

function parsePositiveInteger(value, fallback) {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

export const MODEL_ALIASES = {
  flash: process.env.ASK_GOOGLE_MODEL_FLASH || "gemini-3-flash-preview",
  "flash-lite": process.env.ASK_GOOGLE_MODEL_FLASH_LITE || "gemini-3.1-flash-lite-preview",
  pro: process.env.ASK_GOOGLE_MODEL_PRO || "gemini-3.1-pro-preview",
};

export const VALID_MODELS = Object.freeze(Object.keys(MODEL_ALIASES));

export function parseEnabledModels(rawValue, validModels) {
  if (rawValue === undefined || rawValue === null || rawValue.trim() === "") {
    return { enabled: [...validModels], unknown: [] };
  }

  const tokens = rawValue
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  const seen = new Set();
  const enabled = [];
  const unknown = [];

  for (const token of tokens) {
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);

    if (validModels.includes(token)) {
      enabled.push(token);
    } else {
      unknown.push(token);
    }
  }

  return { enabled, unknown };
}

const { enabled: enabledModels, unknown: unknownAliases } = parseEnabledModels(
  process.env.ASK_GOOGLE_ENABLED_MODELS,
  VALID_MODELS
);

const isDiagnosticFlagInvocation = process.argv
  .slice(2)
  .some((arg) => ["--help", "-h", "--version", "-v"].includes(arg));

for (const alias of unknownAliases) {
  console.error(
    `[CONFIG] ASK_GOOGLE_ENABLED_MODELS: unknown alias "${alias}" ignored (valid: ${VALID_MODELS.join(", ")})`
  );
}

if (enabledModels.length === 0) {
  console.error(
    `[FATAL] ASK_GOOGLE_ENABLED_MODELS must include at least one of: ${VALID_MODELS.join(", ")}`
  );
  if (!isDiagnosticFlagInvocation) {
    process.exit(1);
  }
  enabledModels.push(...VALID_MODELS);
}

export const ENABLED_MODELS = Object.freeze(enabledModels);

// Router config — the router itself is just a small classifier call that picks a downstream model.
// It's optional: ASK_GOOGLE_ROUTER_ENABLED=false disables it entirely (DEFAULT_MODEL then falls
// back to "pro"/first-enabled, preserving the pre-router behavior).
export const ROUTER_ENABLED = (() => {
  const raw = process.env.ASK_GOOGLE_ROUTER_ENABLED;
  if (raw === "false" || raw === "0") return false;
  return true;
})();

export const ROUTER_MODEL_ALIAS = (() => {
  const raw = process.env.ASK_GOOGLE_ROUTER_MODEL || "flash-lite";
  if (!VALID_MODELS.includes(raw)) {
    console.error(
      `[CONFIG] ASK_GOOGLE_ROUTER_MODEL="${raw}" is not a valid alias (valid: ${VALID_MODELS.join(", ")}); using "flash-lite"`
    );
    return "flash-lite";
  }
  return raw;
})();

export const ROUTER_TIMEOUT_MS = parsePositiveInteger(
  process.env.ASK_GOOGLE_ROUTER_TIMEOUT_MS,
  5_000
);

// When the router times out, errors, or returns bad output, we collapse to this model.
// Default is "flash" — the safer middle-ground when we genuinely don't know the query's shape.
// flash-lite is cheaper but can be shallow on harder queries; pro is slow and currently grounds
// less reliably. flash splits the difference.
export const ROUTER_FALLBACK_MODEL = (() => {
  const raw = process.env.ASK_GOOGLE_ROUTER_FALLBACK_MODEL || "flash";
  let candidate = raw;
  if (!VALID_MODELS.includes(candidate)) {
    console.error(
      `[CONFIG] ASK_GOOGLE_ROUTER_FALLBACK_MODEL="${raw}" is not a valid alias; defaulting to "flash"`
    );
    candidate = "flash";
  }
  // Always re-check against ENABLED_MODELS AFTER the valid/default substitution. Otherwise an
  // invalid env value would short-circuit to "flash" and silently bypass the operator's
  // ENABLED_MODELS restriction.
  if (!ENABLED_MODELS.includes(candidate)) {
    const order = ["flash", "flash-lite", "pro"];
    const snapped = order.find((m) => ENABLED_MODELS.includes(m)) || ENABLED_MODELS[0];
    console.error(
      `[CONFIG] Router fallback "${candidate}" not in ENABLED_MODELS; snapping to "${snapped}"`
    );
    return snapped;
  }
  return candidate;
})();

// Router is only actually usable if its own model is in the enabled set. E.g. if someone sets
// ASK_GOOGLE_ENABLED_MODELS=pro (flash-lite disabled), the router can't run and we fall back to
// pre-router behavior.
export const ROUTER_AVAILABLE = ROUTER_ENABLED && ENABLED_MODELS.includes(ROUTER_MODEL_ALIAS);

if (ROUTER_ENABLED && !ROUTER_AVAILABLE && !isDiagnosticFlagInvocation) {
  console.error(
    `[CONFIG] Router disabled: router model "${ROUTER_MODEL_ALIAS}" not in ENABLED_MODELS (${ENABLED_MODELS.join(", ")})`
  );
}

// Model-param values exposed through the MCP tool schema. "auto" is offered when the router is
// available; explicit model aliases are always exposed so callers can still pin a tier.
export const MODEL_PARAM_VALUES = ROUTER_AVAILABLE
  ? Object.freeze(["auto", ...ENABLED_MODELS])
  : Object.freeze([...ENABLED_MODELS]);

export const DEFAULT_MODEL = (() => {
  if (ROUTER_AVAILABLE) return "auto";
  if (ENABLED_MODELS.includes("pro")) return "pro";
  const fallback = ENABLED_MODELS[0];
  console.error(
    `[CONFIG] ASK_GOOGLE_ENABLED_MODELS excludes "pro" and router unavailable; default model falls back to "${fallback}"`
  );
  return fallback;
})();
export const MAX_QUESTION_LENGTH = 4_000;
export const MAX_RETRIES = parsePositiveInteger(process.env.ASK_GOOGLE_MAX_RETRIES, 2);
export const INITIAL_RETRY_DELAY_MS = parsePositiveInteger(
  process.env.ASK_GOOGLE_INITIAL_RETRY_DELAY_MS,
  1_000
);

// Overall budget across all attempts + backoffs. Should match or fit under the MCP client's
// tool-call timeout — configure your client's tool timeout to at least this value, otherwise
// it will cut us off before late retries or the flash fallback can complete.
export const OVERALL_BUDGET_MS = parsePositiveInteger(
  process.env.ASK_GOOGLE_OVERALL_BUDGET_MS,
  300_000
);

// Per-model HARD CEILING — absolute safety net on a single attempt. This only fires if Gemini
// pathologically drip-feeds tokens; the inactivity timeout should catch real stalls long before.
// Actual value is min of this, remaining budget, and any requestTimeoutMs override.
export const MODEL_TIMEOUTS_MS = Object.freeze({
  // Pro's 120s ceiling (not 180s) keeps 3 attempts fitting inside the 300s overall budget
  // even in the unlikely pathological case where every attempt runs to its hard cap.
  pro: parsePositiveInteger(process.env.ASK_GOOGLE_TIMEOUT_PRO_MS, 120_000),
  flash: parsePositiveInteger(process.env.ASK_GOOGLE_TIMEOUT_FLASH_MS, 60_000),
  "flash-lite": parsePositiveInteger(process.env.ASK_GOOGLE_TIMEOUT_FLASH_LITE_MS, 30_000),
});

// Per-model TIME-TO-FIRST-TOKEN cutoff. If no chunk arrives in this window, the stream is
// hung before any output — abort and retry. Pro's TTFT is generous because Gemini 3 Pro's
// Deep Think reasoning delays initial output.
export const MODEL_TTFT_TIMEOUTS_MS = Object.freeze({
  pro: parsePositiveInteger(process.env.ASK_GOOGLE_TTFT_PRO_MS, 45_000),
  flash: parsePositiveInteger(process.env.ASK_GOOGLE_TTFT_FLASH_MS, 10_000),
  "flash-lite": parsePositiveInteger(process.env.ASK_GOOGLE_TTFT_FLASH_LITE_MS, 12_000),
});

// Per-model INTER-CHUNK INACTIVITY timeout. Once streaming has started, this resets with every
// chunk received. If no new chunk arrives within this window, the stream is considered stalled.
// Pro's threshold is large because Deep Think can pause 15-30s mid-stream without emitting
// tokens. Flash/flash-lite don't do Deep Think, so tighter thresholds are safe.
export const MODEL_INACTIVITY_TIMEOUTS_MS = Object.freeze({
  pro: parsePositiveInteger(process.env.ASK_GOOGLE_INACTIVITY_PRO_MS, 45_000),
  flash: parsePositiveInteger(process.env.ASK_GOOGLE_INACTIVITY_FLASH_MS, 15_000),
  "flash-lite": parsePositiveInteger(process.env.ASK_GOOGLE_INACTIVITY_FLASH_LITE_MS, 10_000),
});

// Kept for backward compatibility with callers that want a single generic timeout
// (tests and overrides). Actual per-attempt timeout is resolved per-model.
export const REQUEST_TIMEOUT_MS = parsePositiveInteger(
  process.env.ASK_GOOGLE_TIMEOUT_MS,
  60_000
);

// If the user requested pro and attempts 1/2 failed, attempt 3 falls back to this model.
// flash-only and flash-lite-only users don't get downgraded further.
export const FALLBACK_MODEL = (() => {
  const raw = process.env.ASK_GOOGLE_FALLBACK_MODEL || "flash";
  if (!VALID_MODELS.includes(raw)) {
    console.error(
      `[CONFIG] ASK_GOOGLE_FALLBACK_MODEL="${raw}" is not a valid alias; using "flash"`
    );
    return "flash";
  }
  return raw;
})();
export const FILE_OUTPUT_ENABLED = process.env.ASK_GOOGLE_ALLOW_FILE_OUTPUT === "true";
export const FILE_OUTPUT_BASE_DIR = resolve(
  process.env.ASK_GOOGLE_OUTPUT_DIR || process.cwd()
);

// Gemini 3 `thinkingConfig.thinkingLevel`. Uppercase strings: MINIMAL (flash/flash-lite only),
// LOW, MEDIUM, HIGH. Anything else is ignored with a warning so a bad env doesn't take the
// server down and we fall back to the per-model default below.
const VALID_THINKING_LEVELS = new Set(["MINIMAL", "LOW", "MEDIUM", "HIGH"]);

// Per-model default thinking level when no env var is set.
// Pro defaults to MEDIUM (not the SDK default of HIGH) because HIGH spends the reasoning
// budget heavily and makes the model more likely to answer from its own priors instead of
// actually using search grounding. MEDIUM keeps Pro's depth advantage without making it
// over-confident about training-data knowledge. Flash/flash-lite stay at the SDK default
// (undefined → SDK picks a light thinking level) since they already lean tool-heavy.
const DEFAULT_THINKING_LEVELS = Object.freeze({
  pro: "MEDIUM",
  flash: undefined,
  "flash-lite": undefined,
});

function parseThinkingLevel(rawValue, modelAlias, defaultLevel) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return defaultLevel;
  }
  const normalized = rawValue.trim().toUpperCase();
  if (!VALID_THINKING_LEVELS.has(normalized)) {
    console.error(
      `[CONFIG] Ignoring invalid thinking level "${rawValue}" for ${modelAlias} (valid: ${[...VALID_THINKING_LEVELS].join(", ")}); using default ${defaultLevel ?? "SDK default"}`
    );
    return defaultLevel;
  }
  if (normalized === "MINIMAL" && modelAlias === "pro") {
    console.error(
      `[CONFIG] thinkingLevel=MINIMAL is not supported on pro; using default ${defaultLevel ?? "SDK default"}`
    );
    return defaultLevel;
  }
  return normalized;
}

export const MODEL_THINKING_LEVELS = Object.freeze({
  pro: parseThinkingLevel(
    process.env.ASK_GOOGLE_THINKING_LEVEL_PRO,
    "pro",
    DEFAULT_THINKING_LEVELS.pro
  ),
  flash: parseThinkingLevel(
    process.env.ASK_GOOGLE_THINKING_LEVEL_FLASH,
    "flash",
    DEFAULT_THINKING_LEVELS.flash
  ),
  "flash-lite": parseThinkingLevel(
    process.env.ASK_GOOGLE_THINKING_LEVEL_FLASH_LITE,
    "flash-lite",
    DEFAULT_THINKING_LEVELS["flash-lite"]
  ),
});
