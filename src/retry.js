// Budget-aware retry loop. Each attempt gets the remaining budget (after backoffs) so the
// caller can size its per-attempt timeout to what's actually left, instead of blindly using
// a fixed value that might blow the MCP client's wall-clock tool-call limit.
export async function retryWithBackoff(
  fn,
  {
    maxRetries,
    initialDelayMs,
    shouldRetry,
    onRetry = () => {},
    overallBudgetMs = Infinity,
    minAttemptBudgetMs = 2_000,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
) {
  const start = now();
  const totalAttempts = maxRetries + 1;
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const elapsed = now() - start;
    const remainingBudgetMs = overallBudgetMs - elapsed;

    if (remainingBudgetMs < minAttemptBudgetMs) {
      const err = lastError || new Error("Retry budget exhausted before any attempt ran");
      throw err;
    }

    const attemptStart = now();

    try {
      return await fn({
        attempt: attempt + 1,
        totalAttempts,
        remainingBudgetMs,
        elapsedMs: elapsed,
      });
    } catch (error) {
      lastError = error;
      const attemptDurationMs = now() - attemptStart;

      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }

      const delayMs = initialDelayMs * (2 ** attempt);
      const remainingAfterBackoff = overallBudgetMs - (now() - start) - delayMs;

      // If there's no room left to run the *next* attempt after waiting out the backoff,
      // give up now instead of sleeping pointlessly.
      if (remainingAfterBackoff < minAttemptBudgetMs) {
        throw error;
      }

      onRetry({
        attempt: attempt + 1,
        totalAttempts,
        delayMs,
        error,
        attemptDurationMs,
        remainingBudgetMs: remainingAfterBackoff,
      });
      await sleep(delayMs);
    }
  }

  throw lastError;
}
