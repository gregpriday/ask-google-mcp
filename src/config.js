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
export const DEFAULT_MODEL = "pro";
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
