#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "dotenv";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import { homedir } from "os";

// Load .env file if it exists (supports both local dev and global install)
// First try CWD, then fallback to home directory (won't override existing env)
config({ path: join(process.cwd(), ".env") });
config({ path: join(homedir(), ".env") });

// Get package version
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8")
);

// Handle --help and --version before requiring API key
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`${packageJson.name} v${packageJson.version}`);
  console.log(`\n${packageJson.description}\n`);
  console.log("Usage: ask-google-mcp\n");
  console.log("This is an MCP server that communicates over stdio.");
  console.log("It is intended to be used as a tool provider for MCP-compatible clients.\n");
  console.log("Environment variables:");
  console.log("  GOOGLE_API_KEY    Google AI API key (required)\n");
  console.log("Options:");
  console.log("  -h, --help        Show this help message");
  console.log("  -v, --version     Show version number");
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  console.log(packageJson.version);
  process.exit(0);
}

// Initialize Gemini AI client
const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) {
  console.error("Error: GOOGLE_API_KEY environment variable is required.\n");
  console.error("To get a key, visit: https://aistudio.google.com/apikey");
  console.error("Then set it in your environment:\n");
  console.error("  export GOOGLE_API_KEY=your_api_key_here\n");
  console.error(`For more help, visit: ${packageJson.homepage}`);
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(apiKey);

// Cache system prompt template at startup (only date substitution needed per request)
const systemPromptTemplate = readFileSync(join(__dirname, "system-prompt.txt"), "utf-8");

// Retry configuration
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000; // 1 second

/**
 * Retry helper with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {number} maxRetries - Maximum number of retry attempts
 * @param {number} initialDelay - Initial delay in milliseconds
 * @returns {Promise} Result of the function
 */
async function retryWithBackoff(fn, maxRetries = MAX_RETRIES, initialDelay = INITIAL_RETRY_DELAY) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry on certain error types
      const errorMessage = error.message || "";
      const lowerMessage = errorMessage.toLowerCase();

      // Don't retry auth errors or quota errors (permanent failures)
      if (lowerMessage.includes("api key") ||
          lowerMessage.includes("unauthorized") ||
          lowerMessage.includes("permission") ||
          lowerMessage.includes("401") ||
          lowerMessage.includes("403") ||
          lowerMessage.includes("quota") ||
          lowerMessage.includes("rate limit") ||
          lowerMessage.includes("429") ||
          lowerMessage.includes("resource exhausted")) {
        throw error;
      }

      // If this was the last attempt, throw the error
      if (attempt === maxRetries) {
        throw error;
      }

      // Calculate delay with exponential backoff
      const delay = initialDelay * Math.pow(2, attempt);
      console.error(`[RETRY] Attempt ${attempt + 1}/${maxRetries + 1} failed: ${errorMessage}. Retrying in ${delay}ms...`);

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

// Create MCP server
const server = new Server(
  {
    name: "ask-google",
    version: packageJson.version,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "ask_google",
        description:
          "Grounded Google web research for current/latest info, version checks, and comparisons. Short or long questions; prefer 'current/latest' over hardcoding years.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            question: {
              type: "string",
              description: "Grounded web-search query. Can be a short lookup or long-form, multi-part research request. Prefer 'current/latest/as of today' over hardcoding dates unless a specific historical year matters.",
              minLength: 1,
              maxLength: 10000,
              examples: [
                "Find current ECMAScript standard and key new features",
                "React 19 vs 18: breaking changes, migration steps, and notable new APIs",
                "Find current Node.js LTS version and its release date",
                "Check online: is OpenSSL 3.3.2 released yet? Link release notes if so",
              ],
            },
            output_file: {
              type: "string",
              description: "Optional path to write the response (also returned inline). Absolute or relative; relative resolves from the current working directory. Parent directories are created if needed; existing files are overwritten.",
              examples: [
                "./docs/research.md",
                "output/gemini-response.txt",
                "/Users/john/Documents/research.md",
              ],
            },
            model: {
              type: "string",
              description: "Gemini model: 'pro' (default) for deeper synthesis, 'flash' for quick lookups, 'flash-lite' for cheapest/fastest simple facts.",
              enum: ["flash", "flash-lite", "pro"],
              default: "pro",
              examples: ["flash", "flash-lite", "pro"],
            },
          },
          required: ["question"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "ask_google") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const question = request.params.arguments?.question;
  const outputFile = request.params.arguments?.output_file;
  const modelType = request.params.arguments?.model || "pro";

  // Input validation for question
  if (!question) {
    throw new Error("Missing required parameter: question");
  }

  if (typeof question !== "string") {
    throw new Error("Question must be a string");
  }

  if (question.trim().length === 0) {
    throw new Error("Question cannot be empty");
  }

  if (question.length > 10000) {
    throw new Error("Question exceeds maximum length of 10000 characters");
  }

  // Input validation for output_file (if provided)
  if (outputFile !== undefined && outputFile !== null) {
    if (typeof outputFile !== "string") {
      throw new Error("output_file must be a string");
    }

    if (outputFile.trim().length === 0) {
      throw new Error("output_file cannot be empty");
    }

    // Note: Both absolute and relative paths are supported
    // Relative paths resolve from the current working directory
  }

  // Input validation for model
  const validModels = ["flash", "flash-lite", "pro"];
  if (!validModels.includes(modelType)) {
    throw new Error(`model must be one of: ${validModels.join(", ")}. Got: ${modelType}`);
  }

  // Build the model string
  const modelMap = {
    "flash": "gemini-3-flash-preview",
    "flash-lite": "gemini-3.1-flash-lite-preview",
    "pro": "gemini-3.1-pro-preview",
  };
  const modelString = modelMap[modelType];

  try {
    const systemPrompt = systemPromptTemplate
      .replace("{{CURRENT_DATE}}", new Date().toISOString().slice(0, 10) + " (UTC)");

    // Get the model with search grounding
    const model = genAI.getGenerativeModel({
      model: modelString,
      systemInstruction: systemPrompt,
      tools: [{ googleSearch: {} }],
    });

    // Generate response with search grounding (with retry logic)
    const result = await retryWithBackoff(async () => {
      return await model.generateContent(question);
    });
    const response = result.response;

    // Extract grounding metadata (sources and searches performed)
    const metadata = response.candidates?.[0]?.groundingMetadata;
    const rawSources = metadata?.groundingChunks?.map(chunk => ({
      title: chunk.web?.title || "Unknown",
      url: chunk.web?.uri || "",
      domain: chunk.web?.domain || "",
    })) || [];

    // Deduplicate sources by URL, filter out empty URLs, and cap to avoid bloat
    const seenUrls = new Set();
    const sources = rawSources.filter(source => {
      if (!source.url) return false;
      if (seenUrls.has(source.url)) return false;
      seenUrls.add(source.url);
      return true;
    }).slice(0, 12);

    const searches = (metadata?.webSearchQueries || []).slice(0, 8);

    // Build comprehensive response
    let fullResponse = response.text();

    if (sources.length > 0) {
      fullResponse += "\n\n---\n**Sources:**\n";
      sources.forEach((source, idx) => {
        fullResponse += `\n${idx + 1}. [${source.title}](${source.url})`;
      });
    }

    if (searches.length > 0) {
      fullResponse += "\n\n**Search queries performed:**\n";
      searches.forEach((query, idx) => {
        fullResponse += `\n${idx + 1}. "${query}"`;
      });
    }

    // Write to file if output_file was provided
    if (outputFile) {
      try {
        const resolvedPath = resolve(outputFile);
        mkdirSync(dirname(resolvedPath), { recursive: true });
        writeFileSync(resolvedPath, fullResponse, "utf-8");
        console.error(`[FILE_OUTPUT] Successfully wrote response to: ${resolvedPath}`);
      } catch (fileError) {
        // Log error but don't fail the request - the user still gets the response
        console.error(`[FILE_OUTPUT] Failed to write to ${outputFile}: ${fileError.message}`);
        // Append file write error to response so user knows it failed
        fullResponse += `\n\n---\n**Note:** Failed to write to file '${outputFile}': ${fileError.message}`;
      }
    }

    return {
      content: [
        {
          type: "text",
          text: fullResponse,
        },
      ],
    };
  } catch (error) {
    // MCP-specific error handling with codes
    const errorMessage = error.message || "Generation failed";
    const lowerMessage = errorMessage.toLowerCase();

    // Categorize errors (case-insensitive)
    if (lowerMessage.includes("api key") || lowerMessage.includes("unauthorized") ||
        lowerMessage.includes("permission") || lowerMessage.includes("401") || lowerMessage.includes("403")) {
      throw new Error(`[AUTH_ERROR] Invalid or missing API key: ${errorMessage}`);
    } else if (lowerMessage.includes("quota") || lowerMessage.includes("rate limit") ||
               lowerMessage.includes("429") || lowerMessage.includes("resource exhausted")) {
      throw new Error(`[QUOTA_ERROR] API quota exceeded: ${errorMessage}`);
    } else if (lowerMessage.includes("timeout")) {
      throw new Error(`[TIMEOUT_ERROR] Request timed out: ${errorMessage}`);
    } else {
      throw new Error(`[API_ERROR] Gemini API error: ${errorMessage}`);
    }
  }
});

// Process stability handlers
process.on("unhandledRejection", (reason, promise) => {
  console.error("[FATAL] Unhandled Rejection at:", promise, "Reason:", reason);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  console.error("[FATAL] Uncaught Exception:", error.message, error.stack);
  process.exit(1);
});

// Graceful shutdown handler
process.on("SIGINT", () => {
  console.error("Received SIGINT, shutting down gracefully...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.error("Received SIGTERM, shutting down gracefully...");
  process.exit(0);
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Gemini MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
