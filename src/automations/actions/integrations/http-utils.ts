export const DEFAULT_INTEGRATION_TIMEOUT_MS = 10_000;

export function integrationFetch(
  url: string,
  init?: RequestInit,
  timeoutMs = DEFAULT_INTEGRATION_TIMEOUT_MS,
): Promise<Response> {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((err: unknown) => {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error(
        `Integration request timed out after ${timeoutMs}ms: ${url}`,
      );
    }
    throw err;
  });
}
