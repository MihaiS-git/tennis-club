import { afterEach, expect, it, vi } from "vitest";
import { avatarMutationTransport } from "../../../src/lib/profile/avatar-coordination";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("bounds each HTTP call and preserves caller cancellation", async () => {
  const controller = new AbortController();
  const request = vi.fn(async (_input, init: RequestInit) => {
    expect(init.signal).toBeInstanceOf(AbortSignal);
    controller.abort();
    expect(init.signal?.aborted).toBe(true);
    return new Response();
  });
  const timeout = vi.spyOn(AbortSignal, "timeout");
  vi.stubGlobal("fetch", request);
  await avatarMutationTransport()("http://localhost/storage", { signal: controller.signal });
  expect(timeout).toHaveBeenCalledWith(10_000);
});

it("refuses all HTTP calls from a paused request after its workflow deadline, before lease takeover", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  const request = vi.fn();
  vi.stubGlobal("fetch", request);
  const transport = avatarMutationTransport();
  clock.mockReturnValue(120_000);
  expect(() => transport("http://localhost/storage")).toThrow("Avatar mutation deadline exceeded");
  clock.mockReturnValue(300_001);
  expect(() => transport("http://localhost/storage")).toThrow("Avatar mutation deadline exceeded");
  expect(request).not.toHaveBeenCalled();
});
