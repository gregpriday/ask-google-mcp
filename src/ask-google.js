import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  DEFAULT_MODEL,
  FILE_OUTPUT_BASE_DIR,
  FILE_OUTPUT_ENABLED,
  INITIAL_RETRY_DELAY_MS,
  MAX_RETRIES,
  REQUEST_TIMEOUT_MS,
} from "./config.js";
import { classifyGeminiError, createInternalError, isRetryableGeminiError } from "./errors.js";
import { resolveOutputPath, writeResponseToFile } from "./file-output.js";
import { buildSystemPrompt } from "./prompt.js";
import { retryWithBackoff } from "./retry.js";
import {
  buildToolText,
  extractGroundingData,
  resolveModelId,
  validateAskGoogleArguments,
} from "./tool.js";

async function generateContentWithTimeout(model, question, timeoutMs) {
  const controller = new AbortController();
  let timeout;

  try {
    return await Promise.race([
      model.generateContent(question, { signal: controller.signal }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error(`Request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function createAskGoogleHandler({
  logger = console,
  systemPromptTemplate,
  now = () => new Date(),
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  maxRetries = MAX_RETRIES,
  initialRetryDelayMs = INITIAL_RETRY_DELAY_MS,
  fileOutputEnabled = FILE_OUTPUT_ENABLED,
  fileOutputBaseDir = FILE_OUTPUT_BASE_DIR,
  getApiKey = () => process.env.GOOGLE_API_KEY,
  createClient = (apiKey) => new GoogleGenerativeAI(apiKey),
} = {}) {
  let cachedApiKey;
  let cachedClient;

  function getClient() {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw createInternalError(
        "[AUTH_ERROR] GOOGLE_API_KEY environment variable is required to call ask_google"
      );
    }

    if (!cachedClient || cachedApiKey !== apiKey) {
      cachedApiKey = apiKey;
      cachedClient = createClient(apiKey);
    }

    return cachedClient;
  }

  return async function handleAskGoogle(rawArgs = {}) {
    const { question, outputFile, model = DEFAULT_MODEL } = validateAskGoogleArguments(rawArgs);
    const outputPath = resolveOutputPath(outputFile, {
      enabled: fileOutputEnabled,
      baseDir: fileOutputBaseDir,
    });

    try {
      const modelId = resolveModelId(model);
      const systemInstruction = buildSystemPrompt(systemPromptTemplate, now());
      const client = getClient();
      const generativeModel = client.getGenerativeModel({
        model: modelId,
        systemInstruction,
        tools: [{ googleSearch: {} }],
      });

      const result = await retryWithBackoff(
        () => generateContentWithTimeout(generativeModel, question, requestTimeoutMs),
        {
          maxRetries,
          initialDelayMs: initialRetryDelayMs,
          shouldRetry: isRetryableGeminiError,
          onRetry: ({ attempt, totalAttempts, delayMs, error }) => {
            logger.error(
              `[RETRY] Attempt ${attempt}/${totalAttempts} failed: ${error.message}. Retrying in ${delayMs}ms...`
            );
          },
        }
      );

      const response = result.response;
      const { sources, searches } = extractGroundingData(response);
      let fileWriteError;
      let fullResponse = buildToolText(response.text(), { sources, searches });

      if (outputPath) {
        try {
          writeResponseToFile(outputPath, fullResponse);
          logger.error(`[FILE_OUTPUT] Successfully wrote response to: ${outputPath}`);
        } catch (error) {
          logger.error(`[FILE_OUTPUT] Failed to write to ${outputPath}: ${error.message}`);
          fileWriteError = `Failed to write to file '${outputPath}': ${error.message}`;
          fullResponse = buildToolText(response.text(), { sources, searches, fileWriteError });
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
      if (error.name === "McpError") {
        throw error;
      }

      throw createInternalError(classifyGeminiError(error));
    }
  };
}
