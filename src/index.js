#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "dotenv";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
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

// Initialize Gemini AI client
const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) {
  throw new Error("GOOGLE_API_KEY environment variable is required");
}

const genAI = new GoogleGenerativeAI(apiKey);

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
          lowerMessage.includes("quota") ||
          lowerMessage.includes("rate limit")) {
        throw error;
      }

      // If this was the last attempt, throw the error
      if (attempt === maxRetries) {
        throw error;
      }

      // Calculate delay with exponential backoff
      const delay = initialDelay * Math.pow(2, attempt);
      console.error(`[RETRY] Attempt ${attempt + 1}/${maxRetries} failed: ${errorMessage}. Retrying in ${delay}ms...`);

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
        // Terse description + clear invocation cues
        description:
          "Grounded Google web research. Use when asked to 'check online', 'ask google', 'research', verify latest standards/versions, compare releases, or when current info is needed.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            question: {
              type: "string",
              description: "Research question to answer with grounded web search.",
              minLength: 1,
              maxLength: 10000,
              examples: [
                "Latest ECMAScript standard and new features",
                "React 19: what's new vs 18?",
                "Compare PostgreSQL 16 vs MySQL 8.4 for OLTP",
                "Check online: is OpenSSL 3.3.2 out yet?",
              ],
            },
            output_file: {
              type: "string",
              description: "Optional file path to save the response. Supports both absolute paths (/Users/name/research.md) and relative paths (./docs/research.md). Relative paths resolve from the Claude Code project root. If provided, the response will be written to this file in addition to being returned.",
              examples: [
                "./docs/research.md",
                "output/gemini-response.txt",
                "/Users/john/Documents/research.md",
              ],
            },
            model: {
              type: "string",
              description: "Optional Gemini model to use. Choose 'flash' (default) for most information lookup queries, or 'pro' when you need to search and perform advanced reasoning over the results.",
              enum: ["flash", "pro"],
              default: "flash",
              examples: ["flash", "pro"],
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
  const modelType = request.params.arguments?.model || "flash";

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
    // Relative paths resolve from the Claude Code working directory (project root)
  }

  // Input validation for model
  const validModels = ["flash", "pro"];
  if (!validModels.includes(modelType)) {
    throw new Error(`model must be one of: ${validModels.join(", ")}. Got: ${modelType}`);
  }

  // Build the model string
  const modelMap = {
    "flash": "gemini-3-flash-preview",
    "pro": "gemini-3-pro-preview",
  };
  const modelString = modelMap[modelType];

  try {
    // System prompt optimized for AI agent consumption
    const systemPrompt = `You are answering questions for an AI agent building developer skills and documentation.

Output requirements:
- Be terse and structured (use bullet points, tables, code blocks)
- Focus on: specific syntax, decision rules, anti-patterns, breaking changes, version numbers
- Avoid: marketing language, verbose explanations, unnecessary context
- Include: exact commands, configuration snippets, code examples
- Prioritize: patterns AI can apply directly to code generation
- Format: Problem → Solution → Code Example (when applicable)
- Use tables for comparisons (e.g., "Feature | Old Version | New Version")
- List common mistakes with ❌ wrong code and ✅ correct code side-by-side

Structure responses as actionable reference material, not tutorials.`;

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
    const sources = metadata?.groundingChunks?.map(chunk => ({
      title: chunk.web?.title || "Unknown",
      url: chunk.web?.uri || "",
      domain: chunk.web?.domain || "",
    })) || [];

    const searches = metadata?.webSearchQueries || [];

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
        writeFileSync(outputFile, fullResponse, "utf-8");
        console.error(`[FILE_OUTPUT] Successfully wrote response to: ${outputFile}`);
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
    if (lowerMessage.includes("api key")) {
      throw new Error(`[AUTH_ERROR] Invalid or missing API key: ${errorMessage}`);
    } else if (lowerMessage.includes("quota") || lowerMessage.includes("rate limit")) {
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
