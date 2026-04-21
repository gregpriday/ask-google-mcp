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
  console.log("  ASK_GOOGLE_TIMEOUT_MS           Per-request timeout in milliseconds");
  console.log("  ASK_GOOGLE_ALLOW_FILE_OUTPUT    Set to true to enable output_file writes");
  console.log("  ASK_GOOGLE_OUTPUT_DIR           Base directory allowed for output_file writes");
  console.log("  ASK_GOOGLE_ENABLED_MODELS       Comma-separated aliases to expose: pro, flash, flash-lite (default: all)\n");
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
