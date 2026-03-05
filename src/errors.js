import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

function lowerCaseMessage(error) {
  return String(error?.message || error || "").toLowerCase();
}

export function createInvalidParamsError(message) {
  return new McpError(ErrorCode.InvalidParams, message);
}

export function createInternalError(message) {
  return new McpError(ErrorCode.InternalError, message);
}

export function isRetryableGeminiError(error) {
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
    message.includes("blocked")
  ) {
    return false;
  }

  return true;
}

export function classifyGeminiError(error) {
  const message = String(error?.message || "Generation failed");
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
    lowerMessage.includes("timeout") ||
    lowerMessage.includes("timed out") ||
    lowerMessage.includes("aborted") ||
    lowerMessage.includes("aborterror")
  ) {
    return `[TIMEOUT_ERROR] Request timed out: ${message}`;
  }

  return `[API_ERROR] Gemini API error: ${message}`;
}
