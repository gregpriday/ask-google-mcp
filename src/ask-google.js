import { GoogleGenAI } from "@google/genai";
import {
  DEFAULT_MODEL,
  ENABLED_MODELS,
  FALLBACK_MODEL,
  INITIAL_RETRY_DELAY_MS,
  MAX_RETRIES,
  MODEL_INACTIVITY_TIMEOUTS_MS,
  MODEL_THINKING_LEVELS,
  MODEL_TIMEOUTS_MS,
  MODEL_TTFT_TIMEOUTS_MS,
  OVERALL_BUDGET_MS,
  REQUEST_TIMEOUT_MS,
  ROUTER_AVAILABLE,
  ROUTER_FALLBACK_MODEL,
  ROUTER_MODEL_ALIAS,
  ROUTER_TIMEOUT_MS,
} from "./config.js";
import {
  classifyGeminiError,
  isPermanentFinishReason,
  isRetryableGeminiError,
} from "./errors.js";
import { buildSystemPrompt } from "./prompt.js";
import { retryWithBackoff } from "./retry.js";
import { createRouter } from "./router.js";
import {
  buildStructuredContent,
  buildToolText,
  extractGroundingData,
  resolveModelId,
  validateAskGoogleArguments,
} from "./tool.js";

const SAFETY_BUFFER_MS = 2_000;
const MIN_ATTEMPT_BUDGET_MS = 3_000;
// Hard cap on accumulated streaming text per attempt. Defends against a runaway Gemini
// response (or a buggy stream that never terminates). 500 KB is ~100x the longest realistic
// answer we see (deep research briefs land around 5 KB), so this only fires on pathology.
const MAX_RESPONSE_CHARS = 500_000;

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

function readChunkText(chunk) {
  if (!chunk) return "";
  // GenerateContentResponse.text is a getter that concatenates text parts of the first candidate.
  // Guard against it being undefined on non-text chunks (e.g., pure tool-call signalling).
  const value = chunk.text;
  return typeof value === "string" ? value : "";
}

function readChunkGrounding(chunk) {
  return chunk?.candidates?.[0]?.groundingMetadata ?? null;
}

function readChunkFinishReason(chunk) {
  return chunk?.candidates?.[0]?.finishReason ?? null;
}

// Stream the response under three independent signals:
//   1. TTFT timer — fires if no first chunk arrives within ttftMs. Cleared on first chunk.
//   2. Inactivity timer — after first chunk, resets every time a new chunk arrives. Fires if
//      the stream goes silent for longer than inactivityMs (a real stall, not a slow response).
//   3. Hard ceiling — absolute upper bound on the attempt. Only triggers on pathological
//      drip-feeding; the inactivity timer should catch real hangs long before.
// All three share a single AbortController. Aborting the config.abortSignal closes the TCP
// connection on the SDK's side, so the `for await` loop rejects immediately with an AbortError.
async function streamWithTimeouts(
  modelsClient,
  { model, contents, systemInstruction, tools, thinkingConfig },
  { ttftMs, inactivityMs, hardCeilingMs, logger, attemptLabel, onProgress }
) {
  const controller = new AbortController();
  let ttftTimer;
  let inactivityTimer;
  let hardCeilingTimer;
  let firstTokenAt;
  let abortReason;
  const attemptStart = Date.now();

  const clearTimers = () => {
    if (ttftTimer) clearTimeout(ttftTimer);
    if (inactivityTimer) clearTimeout(inactivityTimer);
    if (hardCeilingTimer) clearTimeout(hardCeilingTimer);
  };

  const armInactivity = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      abortReason = "INACTIVITY_TIMEOUT";
      controller.abort();
    }, inactivityMs);
  };

  ttftTimer = setTimeout(() => {
    if (firstTokenAt === undefined) {
      abortReason = "TTFT_TIMEOUT";
      controller.abort();
    }
  }, ttftMs);

  hardCeilingTimer = setTimeout(() => {
    abortReason = "HARD_CEILING";
    controller.abort();
  }, hardCeilingMs);

  try {
    const config = {
      systemInstruction,
      tools,
      abortSignal: controller.signal,
    };
    if (thinkingConfig) {
      config.thinkingConfig = thinkingConfig;
    }

    const responseStream = await modelsClient.generateContentStream({
      model,
      contents,
      config,
    });

    const textParts = [];
    let charCount = 0;
    let chunkIndex = 0;
    let latestGrounding = null;
    let latestFinishReason = null;

    for await (const chunk of responseStream) {
      chunkIndex += 1;

      if (firstTokenAt === undefined) {
        firstTokenAt = Date.now();
        clearTimeout(ttftTimer);
        logger.error(
          `[${attemptLabel}] first_token ttft_ms=${firstTokenAt - attemptStart}`
        );
      }

      armInactivity();

      const chunkText = readChunkText(chunk);
      if (chunkText) {
        textParts.push(chunkText);
        charCount += chunkText.length;
        if (charCount > MAX_RESPONSE_CHARS) {
          abortReason = "RESPONSE_TOO_LARGE";
          controller.abort();
          // Loop will throw on the next iteration as the abort propagates.
        }
      }

      const grounding = readChunkGrounding(chunk);
      if (grounding) {
        latestGrounding = grounding;
      }

      const finishReason = readChunkFinishReason(chunk);
      if (finishReason) {
        latestFinishReason = finishReason;
      }

      if (onProgress) {
        onProgress({
          chunkIndex,
          charCount,
          elapsedMs: Date.now() - attemptStart,
        });
      }
    }

    // Stream ended cleanly — no more chunks coming, so inactivity timer is no longer relevant.
    if (inactivityTimer) clearTimeout(inactivityTimer);

    return {
      text: textParts.join(""),
      groundingMetadata: latestGrounding,
      finishReason: latestFinishReason,
      firstTokenMs: firstTokenAt !== undefined ? firstTokenAt - attemptStart : null,
      durationMs: Date.now() - attemptStart,
      charCount,
      chunkCount: chunkIndex,
    };
  } catch (error) {
    if (abortReason === "TTFT_TIMEOUT") {
      const err = new Error(`[TTFT_TIMEOUT] No first token within ${ttftMs}ms (stream stalled)`);
      err.code = "TTFT_TIMEOUT";
      throw err;
    }
    if (abortReason === "INACTIVITY_TIMEOUT") {
      const err = new Error(
        `[INACTIVITY_TIMEOUT] Stream went silent for ${inactivityMs}ms mid-response`
      );
      err.code = "INACTIVITY_TIMEOUT";
      throw err;
    }
    if (abortReason === "HARD_CEILING") {
      throw new Error(`Request exceeded hard ceiling of ${hardCeilingMs}ms`);
    }
    if (abortReason === "RESPONSE_TOO_LARGE") {
      const err = new Error(
        `[RESPONSE_TOO_LARGE] Response exceeded ${MAX_RESPONSE_CHARS} characters; aborting to protect server memory`
      );
      err.code = "RESPONSE_TOO_LARGE";
      throw err;
    }
    throw error;
  } finally {
    clearTimers();
  }
}

function errorResult(text) {
  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}

export function createAskGoogleHandler({
  logger = console,
  systemPromptTemplate,
  now = () => new Date(),
  overallBudgetMs = OVERALL_BUDGET_MS,
  modelTimeoutsMs = MODEL_TIMEOUTS_MS,
  modelTtftTimeoutsMs = MODEL_TTFT_TIMEOUTS_MS,
  modelInactivityTimeoutsMs = MODEL_INACTIVITY_TIMEOUTS_MS,
  modelThinkingLevels = MODEL_THINKING_LEVELS,
  fallbackModel = FALLBACK_MODEL,
  // requestTimeoutMs is retained for tests/overrides — when supplied, it acts as a global
  // ceiling on every model's per-attempt timeout.
  requestTimeoutMs,
  maxRetries = MAX_RETRIES,
  initialRetryDelayMs = INITIAL_RETRY_DELAY_MS,
  minAttemptBudgetMs = MIN_ATTEMPT_BUDGET_MS,
  getApiKey = () => process.env.GOOGLE_API_KEY,
  createClient = (apiKey) => new GoogleGenAI({ apiKey }),
  // Router is optional and injectable for testing. If not provided, we build a default one
  // using this handler's config + lazy-loaded client. When ROUTER_AVAILABLE is false (e.g.,
  // router disabled via env or router model not enabled), `router` stays null and `model: "auto"`
  // collapses to the static routerFallbackModel without a network call.
  router: externalRouter,
  routerEnabled = ROUTER_AVAILABLE,
  routerModelAlias = ROUTER_MODEL_ALIAS,
  routerTimeoutMs = ROUTER_TIMEOUT_MS,
  routerFallbackModel = ROUTER_FALLBACK_MODEL,
  enabledModels = ENABLED_MODELS,
} = {}) {
  let cachedApiKey;
  let cachedClient;

  function getClient() {
    const apiKey = getApiKey();
    if (!apiKey) {
      const err = new Error(
        "[AUTH_ERROR] GOOGLE_API_KEY environment variable is required to call ask_google"
      );
      err.code = "AUTH_ERROR";
      err.status = 401;
      throw err;
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

  // Build the router lazily — it holds a reference to getClient, which itself pulls the API key
  // at call time. This keeps the "no API key on startup" behavior intact.
  let router = externalRouter ?? null;
  if (!router && routerEnabled) {
    router = createRouter({
      getClient,
      logger,
      routerModelAlias,
      enabledModels,
      timeoutMs: routerTimeoutMs,
      fallbackModel: routerFallbackModel,
      now,
    });
  }

  return async function handleAskGoogle(rawArgs = {}, { notifyProgress = null } = {}) {
    const { question, model: requestedModel = DEFAULT_MODEL } =
      validateAskGoogleArguments(rawArgs);

    // MCP requires progress values to monotonically increase across a single tool call.
    // Using a rolling counter means retries and the inside-attempt chunk counter can both
    // contribute without ever going backwards.
    let progressCounter = 0;
    const emitProgress = (message) => {
      if (!notifyProgress) return;
      progressCounter += 1;
      try {
        notifyProgress({ progress: progressCounter, message });
      } catch (err) {
        logger.error(`[PROGRESS] notification failed: ${err.message}`);
      }
    };

    const startedAt = Date.now();
    const diagnostics = {
      requestedModel,
      model: requestedModel,
      fellBack: false,
      attempts: 0,
      totalAttempts: maxRetries + 1,
      durationMs: 0,
      ttftMs: null,
      router: null,
    };

    // Resolve "auto" to a concrete model via the router (or router-fallback if no router exists).
    // The rest of the retry loop doesn't know or care whether the model came from a router call
    // or an explicit caller-provided value.
    let resolvedRequestedModel = requestedModel;
    if (requestedModel === "auto") {
      if (router) {
        emitProgress("Routing query...");
        const routerResult = await router(question);
        resolvedRequestedModel = routerResult.model;
        diagnostics.router = {
          pickedModel: routerResult.model,
          durationMs: routerResult.durationMs,
          usedFallback: Boolean(routerResult.usedFallback),
          reason: routerResult.reason,
          snappedFrom: routerResult.snappedFrom,
        };
        logger.error(
          `[ROUTER] picked=${routerResult.model} duration_ms=${routerResult.durationMs}` +
            (routerResult.usedFallback ? ` fallback_reason="${routerResult.reason}"` : "") +
            (routerResult.snappedFrom ? ` snapped_from=${routerResult.snappedFrom}` : "")
        );
        emitProgress(
          routerResult.usedFallback
            ? `Router fell back to ${routerResult.model} (${routerResult.reason})`
            : `Routed to ${routerResult.model}`
        );
      } else {
        // Router disabled at config load (e.g., router model not in ENABLED_MODELS). Collapse
        // to the static fallback without a network call and record the reason for observability.
        resolvedRequestedModel = routerFallbackModel;
        diagnostics.router = {
          pickedModel: routerFallbackModel,
          durationMs: 0,
          usedFallback: true,
          reason: "Router not available (disabled or misconfigured)",
        };
        logger.error(
          `[ROUTER] unavailable; using static fallback=${routerFallbackModel}`
        );
      }
    }
    diagnostics.model = resolvedRequestedModel;

    try {
      const systemInstruction = buildSystemPrompt(systemPromptTemplate, now());
      const client = getClient();
      const modelsClient = client.models;

      const totalAttempts = diagnostics.totalAttempts;

      const streamResult = await retryWithBackoff(
        async ({ attempt, remainingBudgetMs }) => {
          const { model: attemptModel, fellBack } = selectAttemptModel({
            requestedModel: resolvedRequestedModel,
            attempt,
            totalAttempts,
            fallbackModel,
          });
          diagnostics.attempts = attempt;
          diagnostics.model = attemptModel;
          diagnostics.fellBack = fellBack;
          const modelId = resolveModelId(attemptModel);
          const hardCeilingMs = resolveAttemptTimeout(attemptModel, remainingBudgetMs);
          const ttftMs = Math.min(
            modelTtftTimeoutsMs[attemptModel] ?? hardCeilingMs,
            Math.max(1_000, hardCeilingMs - 1_000)
          );
          const inactivityMs = Math.min(
            modelInactivityTimeoutsMs[attemptModel] ?? hardCeilingMs,
            Math.max(1_000, hardCeilingMs - 1_000)
          );
          const attemptLabel = `ATTEMPT ${attempt}/${totalAttempts}`;

          const thinkingLevel = modelThinkingLevels?.[attemptModel];
          const thinkingConfig = thinkingLevel ? { thinkingLevel } : undefined;

          logger.error(
            `[${attemptLabel}] model=${attemptModel}${fellBack ? "(fallback)" : ""} ` +
              `ceiling_ms=${hardCeilingMs} ttft_ms=${ttftMs} inactivity_ms=${inactivityMs} ` +
              `remaining_budget_ms=${remainingBudgetMs}` +
              (thinkingLevel ? ` thinking=${thinkingLevel}` : "")
          );

          emitProgress(
            `Attempt ${attempt}/${totalAttempts} via ${attemptModel}${fellBack ? " (fallback)" : ""}...`
          );

          let lastProgressEmitAt = 0;
          const result = await streamWithTimeouts(
            modelsClient,
            {
              model: modelId,
              contents: question,
              systemInstruction,
              tools: [{ googleSearch: {} }],
              thinkingConfig,
            },
            {
              ttftMs,
              inactivityMs,
              hardCeilingMs,
              logger,
              attemptLabel,
              onProgress: notifyProgress
                ? ({ charCount, elapsedMs }) => {
                    // Time-based throttle: emit at most once per second. This is predictable
                    // regardless of chunk size (a 500-char chunk counts the same as a 5-char chunk).
                    const now = Date.now();
                    if (charCount > 0 && now - lastProgressEmitAt >= 1_000) {
                      lastProgressEmitAt = now;
                      emitProgress(
                        `Streaming response · ${charCount} chars · ${(elapsedMs / 1000).toFixed(1)}s`
                      );
                    }
                  }
                : null,
            }
          );

          const finishReason = result.finishReason;
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
          // Router time must count against the overall budget — otherwise wall time can
          // exceed the advertised OVERALL_BUDGET_MS by up to ROUTER_TIMEOUT_MS. Subtracting
          // the measured router latency keeps the overall ceiling honest; if the router
          // consumed nearly all the budget, retryWithBackoff will correctly refuse to start
          // an attempt.
          overallBudgetMs: overallBudgetMs - (diagnostics.router?.durationMs ?? 0),
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

      const { sources, searches, supports, groundingStatus } = extractGroundingData(
        streamResult.groundingMetadata
      );
      diagnostics.groundingStatus = groundingStatus;

      // Loud stderr log when grounding effectively failed — operators need this signal.
      if (groundingStatus !== "grounded" && groundingStatus !== "sources_only") {
        logger.error(
          `[GROUNDING] status=${groundingStatus} queries=${searches.length} sources=${sources.length} ` +
            `supports=${supports.length} — answer below is from training data, not retrieved evidence`
        );
      }

      const fullResponse = buildToolText(streamResult.text, {
        sources,
        searches,
        supports,
        groundingStatus,
        diagnostics,
      });

      const structuredContent = buildStructuredContent(streamResult.text, {
        sources,
        searches,
        supports,
        groundingStatus,
        diagnostics,
      });

      return {
        content: [
          {
            type: "text",
            text: fullResponse,
          },
        ],
        structuredContent,
      };
    } catch (error) {
      if (error?.name === "McpError") {
        // Protocol-level errors (invalid params) propagate as protocol errors.
        throw error;
      }

      return errorResult(classifyGeminiError(error));
    }
  };
}
