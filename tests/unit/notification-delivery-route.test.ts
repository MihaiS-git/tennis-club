import { afterEach, beforeEach, expect, test, vi } from "vitest";

const { deliver, logged } = vi.hoisted(() => ({ deliver: vi.fn(), logged: vi.fn() }));
vi.mock("@/lib/notifications/booking-delivery", () => ({ deliverPendingBookingNotifications: deliver }));
vi.mock("@/lib/logger", () => ({ logger: { error: logged, warn: logged, info: logged } }));
import { POST } from "@/app/api/notifications/deliver/route";

const secret = "notification-cron-unit-secret-0123456789abcdef";
const request = (authorization?: string) => new Request("http://localhost/api/notifications/deliver",
  { method: "POST", headers: authorization ? { authorization } : {} });
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("NOTIFICATION_CRON_SECRET", secret); });
afterEach(() => vi.unstubAllEnvs());

test("an authenticated scheduled call delivers one small bounded batch through the existing service", async () => {
  deliver.mockResolvedValue({ checked: 2, failed: 1, interrupted: false });
  const response = await POST(request(`Bearer ${secret}`));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ checked: 2, failed: 1 });
  expect(deliver).toHaveBeenCalledOnce();
  const [{ limit, deadline }] = deliver.mock.calls[0];
  expect(limit).toBe(10);
  expect(deadline).toBeLessThanOrEqual(Date.now() + 25_000);
});

test.each([undefined, "Bearer wrong", secret, `bearer ${secret}`, `Bearer ${secret} extra`])("rejects authorization %s without delivering", async header => {
  expect((await POST(request(header))).status).toBe(401);
  expect(deliver).not.toHaveBeenCalled();
});

test.each(["", "too-short"])("an unconfigured or weak secret (%j) disables the endpoint", async value => {
  vi.stubEnv("NOTIFICATION_CRON_SECRET", value);
  expect((await POST(request(`Bearer ${value}`))).status).toBe(503);
  expect(deliver).not.toHaveBeenCalled();
});

test("an interrupted delivery reports failure without credentials or message details", async () => {
  deliver.mockResolvedValue({ checked: 1, failed: 0, interrupted: true });
  const response = await POST(request(`Bearer ${secret}`));
  expect(response.status).toBe(503);
  expect(JSON.stringify(logged.mock.calls)).not.toContain(secret);
});
