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

  const message = lowerCaseMessage(error);

  if (
    message.includes("api key") ||
    message.includes("unauthorized") ||
    message.includes("permission") ||
    message.includes("401") ||
    message.includes("403") ||
    message.includes("quota") ||
    message.includes("rate limit") ||
    message.includes("429") ||
    message.includes("resource exhausted") ||
    message.includes("bad request") ||
    message.includes("invalid argument") ||
    message.includes("not found") ||
    message.includes("safety") ||
    message.includes("recitation") ||
    message.includes("blocklist") ||
    message.includes("blocked")
  ) {
    return false;
  }

  return true;
}

export function classifyGeminiError(error) {
  const message = String(error?.message || "Generation failed");
  const lowerMessage = message.toLowerCase();

  if (error?.finishReason && isPermanentFinishReason(error.finishReason)) {
    return `[CONTENT_BLOCKED] Gemini refused to answer (finishReason=${error.finishReason}): ${message}`;
  }

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
