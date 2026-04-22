import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  DEFAULT_MODEL,
  FALLBACK_MODEL,
  FILE_OUTPUT_BASE_DIR,
  FILE_OUTPUT_ENABLED,
  INITIAL_RETRY_DELAY_MS,
  MAX_RETRIES,
  MODEL_TIMEOUTS_MS,
  MODEL_TTFT_TIMEOUTS_MS,
  OVERALL_BUDGET_MS,
  REQUEST_TIMEOUT_MS,
} from "./config.js";
import {
  classifyGeminiError,
  createInternalError,
  isPermanentFinishReason,
  isRetryableGeminiError,
} from "./errors.js";
import { resolveOutputPath, writeResponseToFile } from "./file-output.js";
import { buildSystemPrompt } from "./prompt.js";
import { retryWithBackoff } from "./retry.js";
import {
  buildToolText,
  extractGroundingData,
  resolveModelId,
  validateAskGoogleArguments,
} from "./tool.js";

const SAFETY_BUFFER_MS = 2_000;
const MIN_ATTEMPT_BUDGET_MS = 3_000;

// Pick the model to use for a given attempt. If the user asked for pro and the last attempt
// is about to run (and it's not the only attempt), swap to the fallback model so we return
// *something* instead of timing out on pro again.
function selectAttemptModel({ requestedModel, attempt, totalAttempts, fallbackModel }) {
  const isLastAttempt = attempt === totalAttempts;
  if (isLastAttempt && totalAttempts > 1 && requestedModel === "pro" && fallbackModel !== "pro") {
    return { model: fallbackModel, fellBack: true };
  }
  return { model: requestedModel, fellBack: false };
}

// Stream the response with both an overall per-attempt timeout AND a TTFT (time-to-first-token)
// timeout. TTFT catches the common hang mode where the SDK's underlying fetch stalls before
// returning any data — we abort fast and let the retry loop try again, rather than sitting
// for the full overall timeout.
async function streamWithTimeouts(generativeModel, question, { overallMs, ttftMs, logger, attemptLabel }) {
  const controller = new AbortController();
  let overallTimer;
  let ttftTimer;
  let firstTokenAt;
  let abortReason;
  const attemptStart = Date.now();

  const clearTimers = () => {
    if (overallTimer) clearTimeout(overallTimer);
    if (ttftTimer) clearTimeout(ttftTimer);
  };

  overallTimer = setTimeout(() => {
    abortReason = "OVERALL_TIMEOUT";
    controller.abort();
  }, overallMs);

  ttftTimer = setTimeout(() => {
    if (firstTokenAt === undefined) {
      abortReason = "TTFT_TIMEOUT";
      controller.abort();
    }
  }, ttftMs);

  try {
    const result = await generativeModel.generateContentStream(question, {
      signal: controller.signal,
    });

    const textParts = [];
    for await (const chunk of result.stream) {
      if (firstTokenAt === undefined) {
        firstTokenAt = Date.now();
        clearTimeout(ttftTimer);
        logger.error(
          `[${attemptLabel}] first_token ttft_ms=${firstTokenAt - attemptStart}`
        );
      }
      const chunkText = typeof chunk.text === "function" ? chunk.text() : "";
      if (chunkText) {
        textParts.push(chunkText);
      }
    }

    const finalResponse = await result.response;
    const text =
      textParts.join("") ||
      (typeof finalResponse?.text === "function" ? finalResponse.text() : "");

    return {
      text,
      response: finalResponse,
      firstTokenMs: firstTokenAt !== undefined ? firstTokenAt - attemptStart : null,
      durationMs: Date.now() - attemptStart,
    };
  } catch (error) {
    if (abortReason === "TTFT_TIMEOUT") {
      const err = new Error(`[TTFT_TIMEOUT] No first token within ${ttftMs}ms (stream stalled)`);
      err.code = "TTFT_TIMEOUT";
      throw err;
    }
    if (abortReason === "OVERALL_TIMEOUT") {
      throw new Error(`Request timed out after ${overallMs}ms`);
    }
    throw error;
  } finally {
    clearTimers();
  }
}

export function createAskGoogleHandler({
  logger = console,
  systemPromptTemplate,
  now = () => new Date(),
  overallBudgetMs = OVERALL_BUDGET_MS,
  modelTimeoutsMs = MODEL_TIMEOUTS_MS,
  modelTtftTimeoutsMs = MODEL_TTFT_TIMEOUTS_MS,
  fallbackModel = FALLBACK_MODEL,
  // requestTimeoutMs is retained for tests/overrides — when supplied, it acts as a global
  // ceiling on every model's per-attempt timeout.
  requestTimeoutMs,
  maxRetries = MAX_RETRIES,
  initialRetryDelayMs = INITIAL_RETRY_DELAY_MS,
  minAttemptBudgetMs = MIN_ATTEMPT_BUDGET_MS,
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

  function resolveAttemptTimeout(modelAlias, remainingBudgetMs) {
    const modelCap = modelTimeoutsMs[modelAlias] ?? REQUEST_TIMEOUT_MS;
    const caps = [modelCap, remainingBudgetMs - SAFETY_BUFFER_MS];
    if (requestTimeoutMs !== undefined) {
      caps.push(requestTimeoutMs);
    }
    return Math.max(MIN_ATTEMPT_BUDGET_MS, Math.min(...caps));
  }

  return async function handleAskGoogle(rawArgs = {}) {
    const { question, outputFile, model: requestedModel = DEFAULT_MODEL } =
      validateAskGoogleArguments(rawArgs);
    const outputPath = resolveOutputPath(outputFile, {
      enabled: fileOutputEnabled,
      baseDir: fileOutputBaseDir,
    });

    const startedAt = Date.now();
    const diagnostics = {
      model: requestedModel,
      fellBack: false,
      attempts: 0,
      totalAttempts: maxRetries + 1,
      durationMs: 0,
      ttftMs: null,
    };

    try {
      const systemInstruction = buildSystemPrompt(systemPromptTemplate, now());
      const client = getClient();

      const totalAttempts = diagnostics.totalAttempts;

      const streamResult = await retryWithBackoff(
        async ({ attempt, remainingBudgetMs }) => {
          const { model: attemptModel, fellBack } = selectAttemptModel({
            requestedModel,
            attempt,
            totalAttempts,
            fallbackModel,
          });
          diagnostics.attempts = attempt;
          diagnostics.model = attemptModel;
          diagnostics.fellBack = fellBack;
          const modelId = resolveModelId(attemptModel);
          const overallMs = resolveAttemptTimeout(attemptModel, remainingBudgetMs);
          const ttftMs = Math.min(
            modelTtftTimeoutsMs[attemptModel] ?? overallMs,
            Math.max(1_000, overallMs - 1_000)
          );
          const attemptLabel = `ATTEMPT ${attempt}/${totalAttempts}`;

          logger.error(
            `[${attemptLabel}] model=${attemptModel}${fellBack ? "(fallback)" : ""} ` +
              `timeout_ms=${overallMs} ttft_ms=${ttftMs} remaining_budget_ms=${remainingBudgetMs}`
          );

          const generativeModel = client.getGenerativeModel({
            model: modelId,
            systemInstruction,
            tools: [{ googleSearch: {} }],
          });

          const result = await streamWithTimeouts(generativeModel, question, {
            overallMs,
            ttftMs,
            logger,
            attemptLabel,
          });

          const finishReason = result.response?.candidates?.[0]?.finishReason;
          if (isPermanentFinishReason(finishReason)) {
            const err = new Error(
              `Gemini returned non-recoverable finishReason=${finishReason}`
            );
            err.finishReason = finishReason;
            throw err;
          }

          if (!result.text || result.text.trim().length === 0) {
            // Empty response with no explicit refusal reason — transient, worth retrying.
            const err = new Error(
              `Gemini returned empty response (finishReason=${finishReason || "none"})`
            );
            throw err;
          }

          diagnostics.ttftMs = result.firstTokenMs;

          logger.error(
            `[${attemptLabel}] success duration_ms=${result.durationMs} ` +
              `finish_reason=${finishReason || "unknown"} ` +
              `ttft_ms=${result.firstTokenMs ?? "n/a"}`
          );

          return result;
        },
        {
          maxRetries,
          initialDelayMs: initialRetryDelayMs,
          overallBudgetMs,
          minAttemptBudgetMs,
          shouldRetry: isRetryableGeminiError,
          onRetry: ({ attempt, totalAttempts: total, delayMs, error, attemptDurationMs, remainingBudgetMs }) => {
            logger.error(
              `[RETRY ${attempt}/${total}] attempt_duration_ms=${attemptDurationMs} ` +
                `backoff_ms=${delayMs} remaining_budget_ms=${remainingBudgetMs} ` +
                `error="${error.message}"`
            );
          },
        }
      );

      diagnostics.durationMs = Date.now() - startedAt;

      const response = streamResult.response;
      const { sources, searches } = extractGroundingData(response);
      let fileWriteError;
      let fullResponse = buildToolText(streamResult.text, { sources, searches, diagnostics });

      if (outputPath) {
        try {
          writeResponseToFile(outputPath, fullResponse);
          logger.error(`[FILE_OUTPUT] Successfully wrote response to: ${outputPath}`);
        } catch (error) {
          logger.error(`[FILE_OUTPUT] Failed to write to ${outputPath}: ${error.message}`);
          fileWriteError = `Failed to write to file '${outputPath}': ${error.message}`;
          fullResponse = buildToolText(streamResult.text, {
            sources,
            searches,
            fileWriteError,
            diagnostics,
          });
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
