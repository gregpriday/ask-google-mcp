#!/usr/bin/env node

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { packageJson } from "./config.js";
import { createAskGoogleHandler } from "./ask-google.js";
import { createAskGoogleServer } from "./server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const systemPromptTemplate = readFileSync(join(__dirname, "system-prompt.txt"), "utf-8");

function printHelp() {
  console.log(`${packageJson.name} v${packageJson.version}`);
  console.log(`\n${packageJson.description}\n`);
  console.log("Usage: ask-google-mcp\n");
  console.log("This is an MCP server that communicates over stdio.");
  console.log("It is intended to be used as a tool provider for MCP-compatible clients.\n");
  console.log("Environment variables:");
  console.log("  GOOGLE_API_KEY                  Google AI API key (required for tool calls)");
  console.log("  ASK_GOOGLE_OVERALL_BUDGET_MS    Total budget across all retries (default: 300000)");
  console.log("  ASK_GOOGLE_TIMEOUT_PRO_MS       Hard ceiling per attempt for pro (default: 120000)");
  console.log("  ASK_GOOGLE_TIMEOUT_FLASH_MS     Hard ceiling per attempt for flash (default: 60000)");
  console.log("  ASK_GOOGLE_TIMEOUT_FLASH_LITE_MS Hard ceiling per attempt for flash-lite (default: 30000)");
  console.log("  ASK_GOOGLE_TTFT_PRO_MS          Time-to-first-token cutoff for pro (default: 45000)");
  console.log("  ASK_GOOGLE_TTFT_FLASH_MS        Time-to-first-token cutoff for flash (default: 10000)");
  console.log("  ASK_GOOGLE_TTFT_FLASH_LITE_MS   Time-to-first-token cutoff for flash-lite (default: 12000)");
  console.log("  ASK_GOOGLE_INACTIVITY_PRO_MS    Inter-chunk silence before abort for pro (default: 45000)");
  console.log("  ASK_GOOGLE_INACTIVITY_FLASH_MS  Inter-chunk silence before abort for flash (default: 15000)");
  console.log("  ASK_GOOGLE_INACTIVITY_FLASH_LITE_MS Inter-chunk silence before abort for flash-lite (default: 10000)");
  console.log("  ASK_GOOGLE_MAX_RETRIES          Retries after the initial attempt (default: 2)");
  console.log("  ASK_GOOGLE_FALLBACK_MODEL       Model used for last attempt when pro keeps failing (default: flash)");
  console.log("  ASK_GOOGLE_THINKING_LEVEL_PRO   Gemini 3 thinking level for pro: LOW|MEDIUM|HIGH (default: MEDIUM)");
  console.log("  ASK_GOOGLE_THINKING_LEVEL_FLASH Gemini 3 thinking level for flash: MINIMAL|LOW|MEDIUM|HIGH (default: SDK default)");
  console.log("  ASK_GOOGLE_THINKING_LEVEL_FLASH_LITE Same for flash-lite (default: SDK default)");
  console.log("  ASK_GOOGLE_ENABLED_MODELS       Comma-separated aliases to expose: pro, flash, flash-lite (default: all)");
  console.log("  ASK_GOOGLE_ROUTER_ENABLED       Enable auto-routing (default: true). When false, model defaults to pro.");
  console.log("  ASK_GOOGLE_ROUTER_MODEL         Model alias used for routing decisions (default: flash-lite)");
  console.log("  ASK_GOOGLE_ROUTER_TIMEOUT_MS    Hard ceiling for the router call (default: 5000)");
  console.log("  ASK_GOOGLE_ROUTER_FALLBACK_MODEL Model used when the router fails (default: flash)\n");
  console.log("Options:");
  console.log("  -h, --help        Show this help message");
  console.log("  -v, --version     Show version number");
}

function installProcessHandlers() {
  process.on("unhandledRejection", (reason, promise) => {
    console.error("[FATAL] Unhandled Rejection at:", promise, "Reason:", reason);
    process.exit(1);
  });

  process.on("uncaughtException", (error) => {
    console.error("[FATAL] Uncaught Exception:", error.message, error.stack);
    process.exit(1);
  });

  // When the MCP client (e.g. Claude Code) kills the server mid-write, the next write to
  // stdout throws EPIPE. Silently exit — there's no one left to log to anyway, and letting
  // it bubble up triggers the [FATAL] handler above with a confusing message.
  process.stdout.on("error", (err) => {
    if (err?.code === "EPIPE") {
      process.exit(0);
    }
  });

  process.on("SIGINT", () => {
    console.error("Received SIGINT, shutting down gracefully...");
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down gracefully...");
    process.exit(0);
  });
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  if (args.includes("--version") || args.includes("-v")) {
    console.log(packageJson.version);
    process.exit(0);
  }

  installProcessHandlers();

  const server = createAskGoogleServer({
    version: packageJson.version,
    askGoogleHandler: createAskGoogleHandler({
      logger: console,
      systemPromptTemplate,
    }),
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Gemini MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
