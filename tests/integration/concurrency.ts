// Lifecycle helpers for real PostgreSQL and provider concurrency tests. Every wait is
// bounded well inside the owning test's timeout, so a missing signal fails the test while
// its finally can still release barriers and drain each started operation before cleanup.
export const boundedWaitMs = 2000;

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// Rejects if the promise does not settle within the bound; the timer never outlives the wait.
export async function bounded<T>(promise: Promise<T>, label: string, ms = boundedWaitMs): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

// Waits for a signal from a started operation. Fails at once if the operation settles
// first, because it can then never send the signal.
export function reached<T>(signal: Promise<T>, operation: Promise<unknown>, label: string): Promise<T> {
  const early = operation.then((): never => { throw new Error(`Settled before ${label}`); });
  early.catch(() => {});
  return bounded(Promise.race([signal, early]), label);
}

// Waits for every concurrent operation, then reports the first rejection, so a failed
// request never leaves its sibling running into later tests.
export async function settled<const T extends readonly unknown[]>(operations: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
  const results = await Promise.allSettled(operations as readonly Promise<unknown>[]);
  const failure = results.find(result => result.status === "rejected");
  if (failure) throw failure.reason;
  return results.map(result => (result as PromiseFulfilledResult<unknown>).value) as unknown as T;
}
