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

export const DEFAULT_MODEL = (() => {
  if (ENABLED_MODELS.includes("pro")) {
    return "pro";
  }
  const fallback = ENABLED_MODELS[0];
  console.error(
    `[CONFIG] ASK_GOOGLE_ENABLED_MODELS excludes "pro"; default model falls back to "${fallback}"`
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
// LOW, MEDIUM, HIGH. If unset, the SDK default applies (HIGH for pro). Anything else is ignored
// with a warning so a bad env doesn't take the server down.
const VALID_THINKING_LEVELS = new Set(["MINIMAL", "LOW", "MEDIUM", "HIGH"]);

function parseThinkingLevel(rawValue, modelAlias) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return undefined;
  }
  const normalized = rawValue.trim().toUpperCase();
  if (!VALID_THINKING_LEVELS.has(normalized)) {
    console.error(
      `[CONFIG] Ignoring invalid thinking level "${rawValue}" for ${modelAlias} (valid: ${[...VALID_THINKING_LEVELS].join(", ")})`
    );
    return undefined;
  }
  if (normalized === "MINIMAL" && modelAlias === "pro") {
    console.error(
      `[CONFIG] thinkingLevel=MINIMAL is not supported on pro; ignoring for pro`
    );
    return undefined;
  }
  return normalized;
}

export const MODEL_THINKING_LEVELS = Object.freeze({
  pro: parseThinkingLevel(process.env.ASK_GOOGLE_THINKING_LEVEL_PRO, "pro"),
  flash: parseThinkingLevel(process.env.ASK_GOOGLE_THINKING_LEVEL_FLASH, "flash"),
  "flash-lite": parseThinkingLevel(
    process.env.ASK_GOOGLE_THINKING_LEVEL_FLASH_LITE,
    "flash-lite"
  ),
});
