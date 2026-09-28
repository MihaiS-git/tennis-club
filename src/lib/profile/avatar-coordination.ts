import "server-only";

// The DB lease lasts five minutes. Stop all workflow HTTP requests after two
// minutes, including compensation, leaving a gap before abandoned-lease takeover.
const workflowTimeoutMs = 120_000;
const requestTimeoutMs = 10_000;

export function avatarMutationTransport() {
  const deadline = performance.now() + workflowTimeoutMs;
  const boundedFetch: typeof fetch = (input, init) => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("Avatar mutation deadline exceeded");
    const timeout = AbortSignal.timeout(Math.ceil(Math.min(requestTimeoutMs, remaining)));
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
    return fetch(input, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  };
  return boundedFetch;
}
