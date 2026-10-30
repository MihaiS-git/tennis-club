import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ expire: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/lib/payments/scheduled-checkout-cleanup", () => ({ cleanupScheduledCheckouts: mocks.expire }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));

import { POST } from "@/app/api/payments/holds/expire/route";

const secret = "local-expiry-cron-secret-at-least-32-chars";
const url = "http://localhost/api/payments/holds/expire";
const call = (authorization?: string) =>
  POST(new Request(url, { method: "POST", headers: authorization ? { authorization } : {} }));
beforeEach(() => { vi.stubEnv("CHECKOUT_EXPIRY_CRON_SECRET", secret); vi.stubEnv("NOTIFICATION_CRON_SECRET", `${secret}-other`); });
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

test("missing, wrong or notification Bearer tokens are rejected before expiry", async () => {
  expect((await call()).status).toBe(401);
  expect((await call("Bearer wrong")).status).toBe(401);
  expect((await call(`Bearer ${secret}-other`)).status).toBe(401);
  vi.stubEnv("CHECKOUT_EXPIRY_CRON_SECRET", "short");
  expect((await call("Bearer short")).status).toBe(401);
  expect(mocks.expire).not.toHaveBeenCalled();
});

test("authenticated Cron runs one bounded expiry batch and returns a compact count", async () => {
  mocks.expire.mockResolvedValue(2);
  const response = await call(`Bearer ${secret}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ expired: 2 });
  expect(mocks.expire).toHaveBeenCalledExactlyOnceWith();
  expect(mocks.revalidate).toHaveBeenCalledWith("/book");
});

test("an idle sweep does not invalidate booking pages", async () => {
  mocks.expire.mockResolvedValue(0);
  expect(await (await call(`Bearer ${secret}`)).json()).toEqual({ expired: 0 });
  expect(mocks.revalidate).not.toHaveBeenCalled();
});

test("expiry failures return an opaque 503", async () => {
  mocks.expire.mockRejectedValue(new Error("connection details"));
  const response = await call(`Bearer ${secret}`);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "Expiry unavailable" });
});

test("the checkout expiry job is configured to run every minute in the local setup and the production instructions", async () => {
  const { readFile } = await import("node:fs/promises");
  const script = await readFile("scripts/setup-local-checkout-expiry-cron.mjs", "utf8");
  expect(script).toContain('["tennis-club-checkout-hold-expiry", "* * * * *", command]');
  const docs = await readFile("docs/payments-memberships.md", "utf8");
  expect(docs).toMatch(/'tennis-club-checkout-hold-expiry',\s*'\* \* \* \* \*'/);
  expect(`${script}\n${docs}`).not.toContain("*/5 * * * *");
});
