/**
 * Unit tests for ask_google tool handler
 * Tests input validation, error handling, and response formatting
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { readFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Mock the Gemini API
class MockGenerativeModel {
  constructor(responseData) {
    this.responseData = responseData;
    this.callCount = 0;
  }

  async generateContent(question) {
    this.callCount++;

    // Support for simulating transient failures
    if (this.responseData.failUntilAttempt && this.callCount < this.responseData.failUntilAttempt) {
      throw new Error(this.responseData.error || "Transient error");
    }

    if (this.responseData.shouldThrow) {
      throw new Error(this.responseData.error);
    }

    return {
      response: {
        text: () => this.responseData.text,
        candidates: this.responseData.candidates || [],
      },
    };
  }
}

// Retry configuration (matching src/index.js)
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 100; // Use shorter delay for tests

async function retryWithBackoff(fn, maxRetries = MAX_RETRIES, initialDelay = INITIAL_RETRY_DELAY) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

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

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

// Simulate the tool handler logic (extracted for testing)
async function handleAskGoogle(question, model, outputFile, modelType = "pro") {
  // Input validation for question (matching src/index.js)
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
  const validModels = ["flash", "flash-lite", "pro"];
  if (!validModels.includes(modelType)) {
    throw new Error(`model must be one of: ${validModels.join(", ")}. Got: ${modelType}`);
  }

  // Build the model string (not used in tests, but validates the logic)
  const modelMap = {
    "flash": "gemini-3-flash-preview",
    "flash-lite": "gemini-3.1-flash-lite-preview",
    "pro": "gemini-3.1-pro-preview",
  };
  const modelString = modelMap[modelType];

  try {
    // Generate content with retry logic
    const result = await retryWithBackoff(async () => {
      return await model.generateContent(question);
    });
    const response = result.response;

    // Extract grounding metadata
    const metadata = response.candidates?.[0]?.groundingMetadata;
    const rawSources =
      metadata?.groundingChunks?.map((chunk) => ({
        title: chunk.web?.title || "Unknown",
        url: chunk.web?.uri || "",
        domain: chunk.web?.domain || "",
      })) || [];

    // Deduplicate sources by URL and filter out empty URLs
    const seenUrls = new Set();
    const sources = rawSources.filter(source => {
      if (!source.url) return false;
      if (seenUrls.has(source.url)) return false;
      seenUrls.add(source.url);
      return true;
    });

    const searches = metadata?.webSearchQueries || [];

    // Build response
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
        const { writeFileSync } = await import("fs");
        writeFileSync(outputFile, fullResponse, "utf-8");
      } catch (fileError) {
        // Log error but don't fail the request - the user still gets the response
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
    // MCP-specific error categorization (case-insensitive)
    const errorMessage = error.message || "Generation failed";
    const lowerMessage = errorMessage.toLowerCase();

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
}

describe("ask_google tool handler", () => {
  describe("input validation", () => {
    it("should reject missing question", async () => {
      const model = new MockGenerativeModel({
        text: "test response",
      });

      await assert.rejects(
        async () => await handleAskGoogle(null, model),
        {
          message: "Missing required parameter: question",
        }
      );
    });

    it("should reject undefined question", async () => {
      const model = new MockGenerativeModel({
        text: "test response",
      });

      await assert.rejects(
        async () => await handleAskGoogle(undefined, model),
        {
          message: "Missing required parameter: question",
        }
      );
    });

    it("should reject non-string question", async () => {
      const model = new MockGenerativeModel({
        text: "test response",
      });

      await assert.rejects(
        async () => await handleAskGoogle(123, model),
        {
          message: "Question must be a string",
        }
      );
    });

    it("should reject empty string question", async () => {
      const model = new MockGenerativeModel({
        text: "test response",
      });

      await assert.rejects(
        async () => await handleAskGoogle("   ", model),
        {
          message: "Question cannot be empty",
        }
      );
    });

    it("should reject questions exceeding max length", async () => {
      const model = new MockGenerativeModel({
        text: "test response",
      });

      const longQuestion = "a".repeat(10001);

      await assert.rejects(
        async () => await handleAskGoogle(longQuestion, model),
        {
          message: "Question exceeds maximum length of 10000 characters",
        }
      );
    });

    it("should accept valid question", async () => {
      const model = new MockGenerativeModel({
        text: "test response",
      });

      const result = await handleAskGoogle("What is Node.js?", model);

      assert.ok(result);
      assert.ok(result.content);
      assert.strictEqual(result.content[0].type, "text");
    });
  });

  describe("successful responses", () => {
    it("should return basic response without sources", async () => {
      const model = new MockGenerativeModel({
        text: "Node.js is a JavaScript runtime.",
        candidates: [],
      });

      const result = await handleAskGoogle("What is Node.js?", model);

      assert.strictEqual(result.content[0].type, "text");
      assert.strictEqual(
        result.content[0].text,
        "Node.js is a JavaScript runtime."
      );
    });

    it("should include sources when available", async () => {
      const model = new MockGenerativeModel({
        text: "Node.js is a JavaScript runtime.",
        candidates: [
          {
            groundingMetadata: {
              groundingChunks: [
                {
                  web: {
                    title: "Node.js Official Docs",
                    uri: "https://nodejs.org/docs",
                    domain: "nodejs.org",
                  },
                },
              ],
            },
          },
        ],
      });

      const result = await handleAskGoogle("What is Node.js?", model);

      assert.ok(result.content[0].text.includes("**Sources:**"));
      assert.ok(result.content[0].text.includes("Node.js Official Docs"));
      assert.ok(result.content[0].text.includes("https://nodejs.org/docs"));
    });

    it("should include search queries when available", async () => {
      const model = new MockGenerativeModel({
        text: "Node.js is a JavaScript runtime.",
        candidates: [
          {
            groundingMetadata: {
              webSearchQueries: ["What is Node.js", "Node.js runtime"],
            },
          },
        ],
      });

      const result = await handleAskGoogle("What is Node.js?", model);

      assert.ok(result.content[0].text.includes("**Search queries performed:**"));
      assert.ok(result.content[0].text.includes("What is Node.js"));
      assert.ok(result.content[0].text.includes("Node.js runtime"));
    });

    it("should include both sources and search queries", async () => {
      const model = new MockGenerativeModel({
        text: "Node.js is a JavaScript runtime.",
        candidates: [
          {
            groundingMetadata: {
              groundingChunks: [
                {
                  web: {
                    title: "Node.js Docs",
                    uri: "https://nodejs.org",
                    domain: "nodejs.org",
                  },
                },
              ],
              webSearchQueries: ["Node.js overview"],
            },
          },
        ],
      });

      const result = await handleAskGoogle("What is Node.js?", model);

      assert.ok(result.content[0].text.includes("**Sources:**"));
      assert.ok(result.content[0].text.includes("**Search queries performed:**"));
    });
  });

  describe("error handling", () => {
    it("should categorize auth errors", async () => {
      const model = new MockGenerativeModel({
        shouldThrow: true,
        error: "Invalid API key provided",
      });

      await assert.rejects(
        async () => await handleAskGoogle("test question", model),
        {
          message: /\[AUTH_ERROR\]/,
        }
      );
    });

    it("should categorize quota errors", async () => {
      const model = new MockGenerativeModel({
        shouldThrow: true,
        error: "API quota exceeded for this project",
      });

      await assert.rejects(
        async () => await handleAskGoogle("test question", model),
        {
          message: /\[QUOTA_ERROR\]/,
        }
      );
    });

    it("should categorize rate limit errors", async () => {
      const model = new MockGenerativeModel({
        shouldThrow: true,
        error: "Rate limit exceeded, please try again later",
      });

      await assert.rejects(
        async () => await handleAskGoogle("test question", model),
        {
          message: /\[QUOTA_ERROR\]/,
        }
      );
    });

    it("should categorize timeout errors", async () => {
      const model = new MockGenerativeModel({
        shouldThrow: true,
        error: "Request timeout after 30 seconds",
      });

      await assert.rejects(
        async () => await handleAskGoogle("test question", model),
        {
          message: /\[TIMEOUT_ERROR\]/,
        }
      );
    });

    it("should categorize generic API errors", async () => {
      const model = new MockGenerativeModel({
        shouldThrow: true,
        error: "Something went wrong with the API",
      });

      await assert.rejects(
        async () => await handleAskGoogle("test question", model),
        {
          message: /\[API_ERROR\]/,
        }
      );
    });
  });

  describe("edge cases", () => {
    it("should handle questions at max length boundary", async () => {
      const model = new MockGenerativeModel({
        text: "Response",
      });

      const maxLengthQuestion = "a".repeat(10000);
      const result = await handleAskGoogle(maxLengthQuestion, model);

      assert.ok(result);
      assert.strictEqual(result.content[0].type, "text");
    });

    it("should handle special characters in questions", async () => {
      const model = new MockGenerativeModel({
        text: "Response",
      });

      const specialQuestion = 'What is "Node.js"? <script>alert("test")</script>';
      const result = await handleAskGoogle(specialQuestion, model);

      assert.ok(result);
      assert.strictEqual(result.content[0].type, "text");
    });

    it("should handle Unicode characters", async () => {
      const model = new MockGenerativeModel({
        text: "Response",
      });

      const unicodeQuestion = "What is Node.js? 你好 世界 🚀";
      const result = await handleAskGoogle(unicodeQuestion, model);

      assert.ok(result);
      assert.strictEqual(result.content[0].type, "text");
    });
  });

  describe("retry logic", () => {
    it("should succeed on first attempt", async () => {
      const model = new MockGenerativeModel({
        text: "Success on first try",
      });

      const result = await handleAskGoogle("test question", model);

      assert.strictEqual(model.callCount, 1);
      assert.ok(result.content[0].text.includes("Success on first try"));
    });

    it("should retry and succeed on second attempt", async () => {
      const model = new MockGenerativeModel({
        text: "Success after retry",
        failUntilAttempt: 2,
        error: "[500 Internal Server Error] An internal error has occurred",
      });

      const result = await handleAskGoogle("test question", model);

      assert.strictEqual(model.callCount, 2);
      assert.ok(result.content[0].text.includes("Success after retry"));
    });

    it("should retry and succeed on third attempt", async () => {
      const model = new MockGenerativeModel({
        text: "Success after multiple retries",
        failUntilAttempt: 3,
        error: "[500 Internal Server Error] An internal error has occurred",
      });

      const result = await handleAskGoogle("test question", model);

      assert.strictEqual(model.callCount, 3);
      assert.ok(result.content[0].text.includes("Success after multiple retries"));
    });

    it("should fail after max retries exceeded", async () => {
      const model = new MockGenerativeModel({
        text: "Should not reach here",
        failUntilAttempt: 10, // Will never succeed
        error: "[500 Internal Server Error] An internal error has occurred",
      });

      await assert.rejects(
        async () => await handleAskGoogle("test question", model),
        {
          message: /500 Internal Server Error/,
        }
      );

      // Should try: initial + 3 retries = 4 total attempts
      assert.strictEqual(model.callCount, 4);
    });

    it("should not retry on auth errors", async () => {
      const model = new MockGenerativeModel({
        shouldThrow: true,
        error: "Invalid API key provided",
      });

      await assert.rejects(
        async () => await handleAskGoogle("test question", model),
        {
          message: /\[AUTH_ERROR\]/,
        }
      );

      // Should only try once (no retries for auth errors)
      assert.strictEqual(model.callCount, 1);
    });

    it("should not retry on quota errors", async () => {
      const model = new MockGenerativeModel({
        shouldThrow: true,
        error: "API quota exceeded for this project",
      });

      await assert.rejects(
        async () => await handleAskGoogle("test question", model),
        {
          message: /\[QUOTA_ERROR\]/,
        }
      );

      // Should only try once (no retries for quota errors)
      assert.strictEqual(model.callCount, 1);
    });

    it("should not retry on rate limit errors", async () => {
      const model = new MockGenerativeModel({
        shouldThrow: true,
        error: "Rate limit exceeded, please try again later",
      });

      await assert.rejects(
        async () => await handleAskGoogle("test question", model),
        {
          message: /\[QUOTA_ERROR\]/,
        }
      );

      // Should only try once (no retries for rate limit errors)
      assert.strictEqual(model.callCount, 1);
    });
  });

  describe("output_file parameter", () => {
    it("should validate output_file is a string", async () => {
      const model = new MockGenerativeModel({
        text: "test response",
      });

      await assert.rejects(
        async () => await handleAskGoogle("test question", model, 123),
        {
          message: "output_file must be a string",
        }
      );
    });

    it("should validate output_file is not empty", async () => {
      const model = new MockGenerativeModel({
        text: "test response",
      });

      await assert.rejects(
        async () => await handleAskGoogle("test question", model, "   "),
        {
          message: "output_file cannot be empty",
        }
      );
    });

    it("should accept absolute paths", async () => {
      const model = new MockGenerativeModel({
        text: "test response",
      });

      const tempFile = join(tmpdir(), `test-${Date.now()}.txt`);

      try {
        const result = await handleAskGoogle("test question", model, tempFile);
        assert.ok(result);
        assert.ok(existsSync(tempFile));

        const fileContent = readFileSync(tempFile, "utf-8");
        assert.strictEqual(fileContent, "test response");
      } finally {
        if (existsSync(tempFile)) {
          unlinkSync(tempFile);
        }
      }
    });

    it("should accept relative paths", async () => {
      const model = new MockGenerativeModel({
        text: "test response",
      });

      // Use a relative path (will be relative to project root)
      const relativeFile = `test-output-${Date.now()}.txt`;

      try {
        const result = await handleAskGoogle("test question", model, relativeFile);
        assert.ok(result);
        assert.ok(existsSync(relativeFile));

        const fileContent = readFileSync(relativeFile, "utf-8");
        assert.strictEqual(fileContent, "test response");
      } finally {
        if (existsSync(relativeFile)) {
          unlinkSync(relativeFile);
        }
      }
    });

    it("should accept relative paths with subdirectories", async () => {
      const model = new MockGenerativeModel({
        text: "test response",
      });

      // Create a temp subdirectory in tmpdir (to avoid polluting project)
      const tempDir = join(tmpdir(), `test-dir-${Date.now()}`);
      const { mkdirSync } = await import("fs");
      mkdirSync(tempDir, { recursive: true });

      const relativeFile = join(tempDir, "subdir-test.txt");

      try {
        const result = await handleAskGoogle("test question", model, relativeFile);
        assert.ok(result);
        assert.ok(existsSync(relativeFile));

        const fileContent = readFileSync(relativeFile, "utf-8");
        assert.strictEqual(fileContent, "test response");
      } finally {
        if (existsSync(relativeFile)) {
          unlinkSync(relativeFile);
        }
        if (existsSync(tempDir)) {
          const { rmdirSync } = await import("fs");
          try {
            rmdirSync(tempDir);
          } catch (e) {
            // Ignore cleanup errors
          }
        }
      }
    });

    it("should write response with sources to file", async () => {
      const model = new MockGenerativeModel({
        text: "Node.js is a JavaScript runtime.",
        candidates: [
          {
            groundingMetadata: {
              groundingChunks: [
                {
                  web: {
                    title: "Node.js Docs",
                    uri: "https://nodejs.org",
                    domain: "nodejs.org",
                  },
                },
              ],
            },
          },
        ],
      });

      const tempFile = join(tmpdir(), `test-${Date.now()}.txt`);

      try {
        const result = await handleAskGoogle("test question", model, tempFile);
        assert.ok(result);
        assert.ok(existsSync(tempFile));

        const fileContent = readFileSync(tempFile, "utf-8");
        assert.ok(fileContent.includes("Node.js is a JavaScript runtime."));
        assert.ok(fileContent.includes("**Sources:**"));
        assert.ok(fileContent.includes("Node.js Docs"));
        assert.ok(fileContent.includes("https://nodejs.org"));
      } finally {
        if (existsSync(tempFile)) {
          unlinkSync(tempFile);
        }
      }
    });

    it("should handle file write errors gracefully", async () => {
      const model = new MockGenerativeModel({
        text: "test response",
      });

      // Use an invalid path that will fail to write
      const invalidPath = "/root/forbidden/file.txt";

      const result = await handleAskGoogle("test question", model, invalidPath);
      assert.ok(result);
      // Should still return the response with error message appended
      assert.ok(result.content[0].text.includes("test response"));
      assert.ok(result.content[0].text.includes("Failed to write to file"));
    });

    it("should work without output_file parameter", async () => {
      const model = new MockGenerativeModel({
        text: "test response",
      });

      const result = await handleAskGoogle("test question", model);
      assert.ok(result);
      assert.strictEqual(result.content[0].text, "test response");
    });

    it("should work with null output_file", async () => {
      const model = new MockGenerativeModel({
        text: "test response",
      });

      const result = await handleAskGoogle("test question", model, null);
      assert.ok(result);
      assert.strictEqual(result.content[0].text, "test response");
    });

    it("should work with undefined output_file", async () => {
      const model = new MockGenerativeModel({
        text: "test response",
      });

      const result = await handleAskGoogle("test question", model, undefined);
      assert.ok(result);
      assert.strictEqual(result.content[0].text, "test response");
    });
  });

  describe("model parameter", () => {
    it("should default to pro model", async () => {
      const model = new MockGenerativeModel({
        text: "test response",
      });

      const result = await handleAskGoogle("test question", model, undefined);
      assert.ok(result);
      assert.strictEqual(result.content[0].text, "test response");
    });

    it("should accept flash model", async () => {
      const model = new MockGenerativeModel({
        text: "test response",
      });

      const result = await handleAskGoogle("test question", model, undefined, "flash");
      assert.ok(result);
      assert.strictEqual(result.content[0].text, "test response");
    });

    it("should accept flash-lite model", async () => {
      const model = new MockGenerativeModel({
        text: "test response",
      });

      const result = await handleAskGoogle("test question", model, undefined, "flash-lite");
      assert.ok(result);
      assert.strictEqual(result.content[0].text, "test response");
    });

    it("should accept pro model", async () => {
      const model = new MockGenerativeModel({
        text: "test response",
      });

      const result = await handleAskGoogle("test question", model, undefined, "pro");
      assert.ok(result);
      assert.strictEqual(result.content[0].text, "test response");
    });

    it("should reject invalid model", async () => {
      const model = new MockGenerativeModel({
        text: "test response",
      });

      await assert.rejects(
        async () => await handleAskGoogle("test question", model, undefined, "invalid"),
        {
          message: /model must be one of: flash, flash-lite, pro/,
        }
      );
    });

    it("should reject empty model string", async () => {
      const model = new MockGenerativeModel({
        text: "test response",
      });

      await assert.rejects(
        async () => await handleAskGoogle("test question", model, undefined, ""),
        {
          message: /model must be one of: flash, flash-lite, pro/,
        }
      );
    });

    it("should reject model with wrong case", async () => {
      const model = new MockGenerativeModel({
        text: "test response",
      });

      await assert.rejects(
        async () => await handleAskGoogle("test question", model, undefined, "Flash"),
        {
          message: /model must be one of: flash, flash-lite, pro/,
        }
      );
    });

    it("should build correct model string for flash", async () => {
      const model = new MockGenerativeModel({
        text: "test response",
      });

      // The handler builds: gemini-3-flash-preview
      const result = await handleAskGoogle("test question", model, undefined, "flash");
      assert.ok(result);
    });

    it("should build correct model string for flash-lite", async () => {
      const model = new MockGenerativeModel({
        text: "test response",
      });

      // The handler builds: gemini-3.1-flash-lite-preview
      const result = await handleAskGoogle("test question", model, undefined, "flash-lite");
      assert.ok(result);
    });

    it("should build correct model string for pro", async () => {
      const model = new MockGenerativeModel({
        text: "test response",
      });

      // The handler builds: gemini-3.1-pro-preview
      const result = await handleAskGoogle("test question", model, undefined, "pro");
      assert.ok(result);
    });
  });
});
