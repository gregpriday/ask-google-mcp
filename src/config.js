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
export const MAX_QUESTION_LENGTH = 10_000;
export const MAX_RETRIES = parsePositiveInteger(process.env.ASK_GOOGLE_MAX_RETRIES, 3);
export const INITIAL_RETRY_DELAY_MS = parsePositiveInteger(
  process.env.ASK_GOOGLE_INITIAL_RETRY_DELAY_MS,
  1_000
);
export const REQUEST_TIMEOUT_MS = parsePositiveInteger(
  process.env.ASK_GOOGLE_TIMEOUT_MS,
  300_000
);
export const FILE_OUTPUT_ENABLED = process.env.ASK_GOOGLE_ALLOW_FILE_OUTPUT === "true";
export const FILE_OUTPUT_BASE_DIR = resolve(
  process.env.ASK_GOOGLE_OUTPUT_DIR || process.cwd()
);
