import { ApiError } from "@google/genai";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

// Finish reasons that represent permanent model-side refusals — retrying will not help.
const PERMANENT_FINISH_REASONS = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "OTHER",
]);

function lowerCaseMessage(error) {
  return String(error?.message || error || "").toLowerCase();
}

function getApiStatus(error) {
  if (error instanceof ApiError && typeof error.status === "number") {
    return error.status;
  }
  // Some fetch-layer errors surface status as a plain property even when they aren't ApiError.
  if (typeof error?.status === "number") {
    return error.status;
  }
  return null;
}

export function createInvalidParamsError(message) {
  return new McpError(ErrorCode.InvalidParams, message);
}

export function createInternalError(message) {
  return new McpError(ErrorCode.InternalError, message);
}

export function isPermanentFinishReason(finishReason) {
  if (!finishReason) {
    return false;
  }
  return PERMANENT_FINISH_REASONS.has(String(finishReason).toUpperCase());
}

export function isRetryableGeminiError(error) {
  // An error carrying a permanent finishReason should not be retried.
  if (error?.finishReason && isPermanentFinishReason(error.finishReason)) {
    return false;
  }

  // Prefer HTTP status when available (new SDK): 4xx (except 408/429) and 501 are permanent.
  const status = getApiStatus(error);
  if (status !== null) {
    if (status === 408 || status === 429) return true;
    if (status >= 500 && status !== 501) return true;
    if (status >= 400 && status < 500) return false;
  }

  // Fallback to string heuristics for non-ApiError throws (internal timeouts, SDK wrappers, etc).
  const message = lowerCaseMessage(error);

  if (
    message.includes("api key") ||
    message.includes("unauthorized") ||
    message.includes("permission") ||
    message.includes("401") ||
    message.includes("403") ||
    message.includes("quota") ||
    message.includes("rate limit") ||
    message.includes("resource exhausted") ||
    message.includes("bad request") ||
    message.includes("invalid argument") ||
    message.includes("not found") ||
    message.includes("safety") ||
    message.includes("recitation") ||
    message.includes("blocklist") ||
    message.includes("blocked")
  ) {
    // Quota/rate-limit messages should still retry; everything else here is a permanent 4xx.
    if (message.includes("quota") || message.includes("rate limit") || message.includes("resource exhausted")) {
      return true;
    }
    return false;
  }

  return true;
}

export function classifyGeminiError(error) {
  const message = String(error?.message || "Generation failed");

  if (error?.finishReason && isPermanentFinishReason(error.finishReason)) {
    return `[CONTENT_BLOCKED] Gemini refused to answer (finishReason=${error.finishReason}): ${message}`;
  }

  const status = getApiStatus(error);
  if (status !== null) {
    if (status === 401 || status === 403) {
      return `[AUTH_ERROR] Invalid or missing API key (HTTP ${status}): ${message}`;
    }
    if (status === 429) {
      return `[QUOTA_ERROR] API quota or rate limit exceeded (HTTP 429): ${message}`;
    }
    if (status === 400 || status === 404) {
      return `[API_ERROR] Invalid request (HTTP ${status}): ${message}`;
    }
    if (status >= 500) {
      return `[API_ERROR] Gemini upstream error (HTTP ${status}): ${message}`;
    }
  }

  const lowerMessage = message.toLowerCase();

  if (
    lowerMessage.includes("api key") ||
    lowerMessage.includes("unauthorized") ||
    lowerMessage.includes("permission") ||
    lowerMessage.includes("401") ||
    lowerMessage.includes("403")
  ) {
    return `[AUTH_ERROR] Invalid or missing API key: ${message}`;
  }

  if (
    lowerMessage.includes("quota") ||
    lowerMessage.includes("rate limit") ||
    lowerMessage.includes("429") ||
    lowerMessage.includes("resource exhausted")
  ) {
    return `[QUOTA_ERROR] API quota exceeded: ${message}`;
  }

  if (
    lowerMessage.includes("ttft") ||
    lowerMessage.includes("first token") ||
    lowerMessage.includes("stalled")
  ) {
    return `[STALL_ERROR] Gemini stream stalled before first token: ${message}`;
  }

  if (
    lowerMessage.includes("timeout") ||
    lowerMessage.includes("timed out") ||
    lowerMessage.includes("aborted") ||
    lowerMessage.includes("aborterror")
  ) {
    return `[TIMEOUT_ERROR] Request timed out: ${message}`;
  }

  if (lowerMessage.includes("budget")) {
    return `[BUDGET_EXHAUSTED] Retry budget exhausted before a successful response: ${message}`;
  }

  return `[API_ERROR] Gemini API error: ${message}`;
}
