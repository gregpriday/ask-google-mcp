export async function retryWithBackoff(
  fn,
  {
    maxRetries,
    initialDelayMs,
    shouldRetry,
    onRetry = () => {},
  }
) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }

      const delayMs = initialDelayMs * (2 ** attempt);
      onRetry({ attempt: attempt + 1, totalAttempts: maxRetries + 1, delayMs, error });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
