#!/usr/bin/env node

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const REQUIRED_ENV_VARS = [
  {
    name: "GOOGLE_API_KEY",
    description: "Google API key for Gemini API access",
    remediation: "Get your API key from: https://aistudio.google.com/apikey",
    validator: (value) => {
      if (!value || value === "your_api_key_here") {
        return "API key appears to be a placeholder value";
      }
      if (value.length < 20) {
        return "API key appears to be too short (likely invalid)";
      }
      return null;
    },
  },
];

const OPTIONAL_ENV_VARS = [
  {
    name: "NODE_ENV",
    description: "Node environment",
    default: "development",
  },
  {
    name: "ASK_GOOGLE_TIMEOUT_MS",
    description: "Per-request timeout in milliseconds",
    default: "30000",
    validator: (value) => {
      if (value === undefined) {
        return null;
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return "Must be a positive integer";
      }
      return null;
    },
  },
  {
    name: "ASK_GOOGLE_MODEL_PRO",
    description: "Override the model id used for the 'pro' alias",
  },
  {
    name: "ASK_GOOGLE_MODEL_FLASH",
    description: "Override the model id used for the 'flash' alias",
  },
  {
    name: "ASK_GOOGLE_MODEL_FLASH_LITE",
    description: "Override the model id used for the 'flash-lite' alias",
  },
  {
    name: "ASK_GOOGLE_ENABLED_MODELS",
    description:
      "Comma-separated model aliases to expose (default: all). Valid aliases: pro, flash, flash-lite.",
    validator: (value) => {
      if (!value || !value.trim()) {
        return null;
      }
      const validAliases = ["pro", "flash", "flash-lite"];
      const tokens = value
        .split(",")
        .map((token) => token.trim())
        .filter((token) => token.length > 0);
      const valid = tokens.filter((token) => validAliases.includes(token));
      if (valid.length === 0) {
        return `No valid aliases found; must include at least one of: ${validAliases.join(", ")}`;
      }
      return null;
    },
  },
];

function parseEnvFile(filePath) {
  try {
    const envContent = readFileSync(filePath, "utf-8");
    const envVars = {};

    envContent.split("\n").forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        return;
      }

      const [key, ...valueParts] = trimmed.split("=");
      if (key) {
        envVars[key.trim()] = valueParts.join("=").trim();
      }
    });

    return envVars;
  } catch (error) {
    console.error(`ERROR: Failed to read ${filePath}: ${error.message}`);
    return null;
  }
}

function loadEnvFiles() {
  const projectEnvPath = join(projectRoot, ".env");
  const homeEnvPath = join(homedir(), ".env");
  const projectVars = existsSync(projectEnvPath) ? parseEnvFile(projectEnvPath) : {};
  const homeVars = existsSync(homeEnvPath) ? parseEnvFile(homeEnvPath) : {};

  if (projectVars === null || homeVars === null) {
    return null;
  }

  return { ...homeVars, ...projectVars };
}

function getValue(envVars, name) {
  return envVars[name] ?? process.env[name];
}

function checkEnvFiles() {
  const projectEnvPath = join(projectRoot, ".env");
  const homeEnvPath = join(homedir(), ".env");

  console.log("Checking environment configuration...\n");

  if (existsSync(projectEnvPath)) {
    console.log("OK: .env file found in project root");
    return true;
  }

  if (existsSync(homeEnvPath)) {
    console.log("OK: .env file found in home directory");
    return true;
  }

  console.log("INFO: No .env file found; falling back to process environment");
  return false;
}

function validateRequiredVars(envVars, hasEnvFile) {
  console.log("\nValidating required environment variables...\n");
  let success = true;

  for (const envVar of REQUIRED_ENV_VARS) {
    const value = getValue(envVars, envVar.name);
    if (!value) {
      console.error(`MISSING: ${envVar.name}`);
      console.error(`  Description: ${envVar.description}`);
      console.error(`  Remediation: ${envVar.remediation}`);
      if (!hasEnvFile) {
        console.error(`  Or create a .env file with ${envVar.name}=your_value`);
      }
      console.error("");
      success = false;
      continue;
    }

    const validationError = envVar.validator?.(value);
    if (validationError) {
      console.error(`INVALID: ${envVar.name}`);
      console.error(`  Issue: ${validationError}`);
      console.error(`  Remediation: ${envVar.remediation}\n`);
      success = false;
      continue;
    }

    console.log(`OK: ${envVar.name} (length=${value.length})`);
  }

  return success;
}

function validateOptionalVars(envVars) {
  console.log("\nChecking optional environment variables...\n");
  let success = true;

  for (const envVar of OPTIONAL_ENV_VARS) {
    const value = getValue(envVars, envVar.name);
    if (value === undefined) {
      const suffix = envVar.default ? ` (default: ${envVar.default})` : "";
      console.log(`INFO: ${envVar.name} not set${suffix}`);
      continue;
    }

    const validationError = envVar.validator?.(value);
    if (validationError) {
      console.error(`INVALID: ${envVar.name}`);
      console.error(`  Issue: ${validationError}`);
      success = false;
      continue;
    }

    console.log(`OK: ${envVar.name}=${value}`);
  }

  return success;
}

function checkNodeVersion() {
  console.log("\nChecking Node.js version...\n");

  const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf-8"));
  const requiredVersion = packageJson.engines?.node;
  const currentVersion = process.version;

  console.log(`  Required: ${requiredVersion || "not specified"}`);
  console.log(`  Current:  ${currentVersion}`);

  if (!requiredVersion) {
    return true;
  }

  const match = requiredVersion.match(/>=(\d+)/);
  if (!match) {
    return true;
  }

  const requiredMajor = Number.parseInt(match[1], 10);
  const currentMajor = Number.parseInt(currentVersion.slice(1).split(".")[0], 10);
  if (currentMajor < requiredMajor) {
    console.error(`Node.js version too old. Please upgrade to ${requiredVersion}`);
    return false;
  }

  console.log("OK: Node.js version is compatible");
  return true;
}

function main() {
  console.log("=".repeat(60));
  console.log("  Ask Google MCP Server - Environment Validation");
  console.log("=".repeat(60));

  const hasEnvFile = checkEnvFiles();
  const envVars = loadEnvFiles();
  let success = envVars !== null;

  success = validateRequiredVars(envVars || {}, hasEnvFile) && success;
  success = validateOptionalVars(envVars || {}) && success;
  success = checkNodeVersion() && success;

  console.log("\n" + "=".repeat(60));
  if (success) {
    console.log("Environment validation passed");
    console.log("=".repeat(60));
    console.log("\nYou can now run: npm start\n");
    process.exit(0);
  }

  console.log("Environment validation failed");
  console.log("=".repeat(60));
  console.log("\nFix the issues above before running the server.\n");
  process.exit(1);
}

main();
