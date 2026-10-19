import { afterEach, beforeEach, expect, test, vi } from "vitest";

const { deliver, logged } = vi.hoisted(() => ({ deliver: vi.fn(), logged: vi.fn() }));
const { recover } = vi.hoisted(() => ({ recover: vi.fn() }));
vi.mock("@/lib/notifications/booking-delivery", () => ({ deliverPendingBookingNotifications: deliver }));
vi.mock("@/lib/notifications/booking-recovery", () => ({ recoverBookingNotifications: recover }));
vi.mock("@/lib/logger", () => ({ logger: { error: logged, warn: logged, info: logged } }));
import { POST } from "@/app/api/notifications/deliver/route";

const secret = "notification-cron-unit-secret-0123456789abcdef";
const request = (authorization?: string) => new Request("http://localhost/api/notifications/deliver",
  { method: "POST", headers: authorization ? { authorization } : {} });
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("NOTIFICATION_CRON_SECRET", secret); recover.mockResolvedValue({ recovered: 0, failed: 0 }); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

test("an authenticated scheduled call delivers one small bounded batch through the existing service", async () => {
  deliver.mockResolvedValue({ checked: 2, failed: 1, interrupted: false });
  const response = await POST(request(`Bearer ${secret}`));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ checked: 2, failed: 1 });
  expect(deliver).toHaveBeenCalledOnce();
  expect(recover).toHaveBeenCalledOnce();
  const [{ limit, deadline }] = deliver.mock.calls[0];
  expect(limit).toBe(10);
  expect(deadline).toBeLessThanOrEqual(Date.now() + 25_000);
});

test.each([undefined, "Bearer wrong", secret, `bearer ${secret}`, `Bearer ${secret} extra`])("rejects authorization %s without delivering", async header => {
  expect((await POST(request(header))).status).toBe(401);
  expect(deliver).not.toHaveBeenCalled();
  expect(recover).not.toHaveBeenCalled();
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

test("a discovery failure is reported while already queued mail still drains", async () => {
  recover.mockRejectedValue(new Error("database unavailable"));
  deliver.mockResolvedValue({ checked: 1, failed: 0, interrupted: false });
  expect((await POST(request(`Bearer ${secret}`))).status).toBe(503);
  expect(deliver).toHaveBeenCalledOnce();
});

test("recovery has a shorter deadline and its timeout preserves delivery time", async () => {
  vi.useFakeTimers();
  const start = Date.now();
  recover.mockImplementation(async ({ deadline }) => {
    expect(deadline).toBe(start + 8_000);
    vi.setSystemTime(deadline + 500);
    throw new Error("statement timeout");
  });
  deliver.mockImplementation(async ({ deadline }) => {
    expect(deadline - Date.now()).toBeGreaterThanOrEqual(16_000);
    return { checked: 1, failed: 0, interrupted: false };
  });
  expect((await POST(request(`Bearer ${secret}`))).status).toBe(503);
  expect(deliver).toHaveBeenCalledOnce();
});

test("individual reconstruction failures report partial failure while other due mail can still drain", async () => {
  recover.mockResolvedValue({ recovered: 1, failed: 1 });
  deliver.mockResolvedValue({ checked: 1, failed: 0, interrupted: false });
  expect((await POST(request(`Bearer ${secret}`))).status).toBe(503);
  expect(deliver).toHaveBeenCalledOnce();
});
