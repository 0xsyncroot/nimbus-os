// backoff.ts — SPEC-306: Pure exponential backoff utility.
// Extracted for testability without SDK dependency.

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  maxAttempts: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: 1_000,
  maxMs: 30_000,
  maxAttempts: 5,
};

/**
 * Compute delay for a given attempt number (0-indexed).
 * Formula: min(baseMs * 2^attempt, maxMs)
 */
export function computeBackoffDelay(attempt: number, opts: BackoffOptions = DEFAULT_BACKOFF): number {
  return Math.min(opts.baseMs * Math.pow(2, attempt), opts.maxMs);
}

/**
 * Run an async operation with exponential backoff.
 * Throws the last error if all attempts fail.
 *
 * @param op - async operation to retry
 * @param opts - backoff configuration
 * @param sleep - sleep function (injectable for tests)
 * @param onRetry - optional callback on each retry
 */
export async function withBackoff<T>(
  op: () => Promise<T>,
  opts: BackoffOptions = DEFAULT_BACKOFF,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  onRetry?: (attempt: number, delayMs: number, err: Error) => void,
): Promise<T> {
  let lastErr: Error | undefined;

  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt + 1 < opts.maxAttempts) {
        const delayMs = computeBackoffDelay(attempt, opts);
        onRetry?.(attempt, delayMs, lastErr);
        await sleep(delayMs);
      }
    }
  }

  throw lastErr!;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
