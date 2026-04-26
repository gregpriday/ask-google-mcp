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
  console.log("  ASK_GOOGLE_ROUTER_FALLBACK_MODEL Model used when the router fails (default: flash)");
  console.log("  ASK_GOOGLE_MAX_QUESTION_LENGTH  Max characters per question (default: 64000, ~16k tokens)\n");
  console.log("Options:");
  console.log("  -h, --help        Show this help message");
  console.log("  -v, --version     Show version number");
}

let unhandledRejectionCount = 0;
const recentRejectionTimestamps = [];
const REJECTION_BURST_WINDOW_MS = 60_000;
const REJECTION_BURST_THRESHOLD = 5;

function installProcessHandlers() {
  // Stay alive on unhandled promise rejections. This server is a stateless Gemini wrapper
  // and can have multiple concurrent in-flight tool calls — exiting on a stray rejection
  // (e.g. a network race deep in the SDK) torpedoes every other call, which surfaces to
  // clients as MCP error -32000 "Connection closed". Log loudly instead so the next time
  // it happens we have evidence to chase.
  process.on("unhandledRejection", (reason) => {
    unhandledRejectionCount += 1;
    const ts = new Date().toISOString();
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : null;
    console.error(
      `[${ts}] [UNHANDLED_REJECTION] count=${unhandledRejectionCount} message=${JSON.stringify(message)}`
    );
    if (stack) {
      console.error(stack);
    }

    // Burst detector: if rejections start piling up in a short window, the operator needs
    // a louder signal that something is genuinely wrong (vs. one stray race). We still
    // don't exit — that decision belongs to the operator — but we surface a HEALTH_WARNING
    // they can grep for.
    const now = Date.now();
    recentRejectionTimestamps.push(now);
    while (recentRejectionTimestamps[0] < now - REJECTION_BURST_WINDOW_MS) {
      recentRejectionTimestamps.shift();
    }
    if (recentRejectionTimestamps.length >= REJECTION_BURST_THRESHOLD) {
      console.error(
        `[${ts}] [HEALTH_WARNING] ${recentRejectionTimestamps.length} unhandled rejections in last ` +
          `${REJECTION_BURST_WINDOW_MS / 1000}s — server is degraded but staying alive. Consider restarting the MCP.`
      );
    }
  });

  // Uncaught exceptions can leave the V8 heap in an inconsistent state, so the safe move
  // is still to exit and let the MCP client respawn us. Log richly first.
  process.on("uncaughtException", (error) => {
    const ts = new Date().toISOString();
    console.error(
      `[${ts}] [UNCAUGHT_EXCEPTION] message=${JSON.stringify(error?.message ?? String(error))}`
    );
    if (error?.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  });

  // When the MCP client (e.g. Claude Code) kills the server mid-write, the next write to
  // stdout throws EPIPE. Silently exit — there's no one left to log to anyway.
  process.stdout.on("error", (err) => {
    if (err?.code === "EPIPE") {
      process.exit(0);
    }
  });

  // Parent disconnected (closed our stdin). Without this, Node may keep the event loop
  // alive even though we have no one to talk to, or worse, write framing to a dead pipe.
  process.stdin.on("end", () => {
    console.error(`[${new Date().toISOString()}] [STDIN_CLOSED] parent disconnected, exiting`);
    process.exit(0);
  });
  process.stdin.on("error", (err) => {
    console.error(
      `[${new Date().toISOString()}] [STDIN_ERROR] code=${err?.code} message=${JSON.stringify(err?.message ?? String(err))}`
    );
    process.exit(0);
  });

  process.on("SIGINT", () => {
    console.error("Received SIGINT, shutting down gracefully...");
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down gracefully...");
    process.exit(0);
  });

  // SIGHUP fires when the controlling terminal goes away (or sometimes on `npm run dev`
  // file-change restarts). Exit cleanly so the next call respawns us cleanly too.
  process.on("SIGHUP", () => {
    console.error("Received SIGHUP, shutting down gracefully...");
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
