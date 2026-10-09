import "server-only";

// Bound each HTTP request independently; no lease or overall workflow deadline.
export function avatarTransport() {
  const boundedFetch: typeof fetch = (input, init) => {
    const timeout = AbortSignal.timeout(10_000);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
    return fetch(input, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  };
  return boundedFetch;
}
