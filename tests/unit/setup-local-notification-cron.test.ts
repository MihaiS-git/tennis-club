import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(), query: vi.fn(), end: vi.fn(),
}));

vi.mock("pg", () => ({
  default: {
    Client: class {
      connect = mocks.connect;
      query = mocks.query;
      end = mocks.end;
    },
  },
}));

const setup = () => import("../../scripts/setup-local-notification-cron.mjs");

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("NOTIFICATION_TEST_RUNNER", "");
  vi.stubEnv("DATABASE_URL", "postgresql://postgres:local@127.0.0.1:54322/postgres");
  vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("NOTIFICATION_CRON_URL", "http://host.docker.internal:3000/api/notifications/deliver");
  vi.stubEnv("NOTIFICATION_CRON_SECRET", "test-notification-secret-at-least-32-characters");
  vi.stubEnv("NOTIFICATION_EMAIL_MODE", "live");
  mocks.query.mockResolvedValue({ rows: [] });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test.each([undefined, "", "   ", "2026-10-22T17:30:57.290Z", " 2026-10-22T20:30:57+03:00 "])(
  "schedules every five minutes with optional cutoff %s", async (cutoff) => {
    vi.stubEnv("NOTIFICATION_DELIVERY_NOT_BEFORE", cutoff);
    await setup();
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.query).toHaveBeenCalledWith("SELECT cron.schedule($1,$2,$3)", [
      "tennis-club-notification-delivery", "*/5 * * * *",
      expect.stringContaining("'Authorization','Bearer '"),
    ]);
    expect(mocks.query).toHaveBeenCalledWith("COMMIT");
    expect(process.env.NOTIFICATION_DELIVERY_NOT_BEFORE).toBe(cutoff);
    expect(mocks.end).toHaveBeenCalledOnce();
  },
);

test.each(["invalid", "2026-10-22", "2026-02-30T17:30:57Z"])(
  "rejects malformed cutoff %s before connecting", async (cutoff) => {
    vi.stubEnv("NOTIFICATION_DELIVERY_NOT_BEFORE", cutoff);
    await expect(setup()).rejects.toThrow("valid ISO timestamp");
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  },
);

test.each([
  ["NODE_ENV", "production"],
  ["NOTIFICATION_TEST_RUNNER", "1"],
  ["SUPABASE_URL", "https://example.com"],
  ["DATABASE_URL", "postgresql://postgres:local@example.com:54322/postgres"],
  ["DATABASE_URL", "postgresql://postgres:local@127.0.0.1:54322/postgres?host=example.com"],
  ["NOTIFICATION_CRON_URL", "https://example.com/api/notifications/deliver"],
  ["NOTIFICATION_EMAIL_MODE", "sandbox"],
  ["NOTIFICATION_CRON_SECRET", "short"],
])("preserves the %s security check without a cutoff", async (name, value) => {
  vi.stubEnv("NOTIFICATION_DELIVERY_NOT_BEFORE", "");
  vi.stubEnv(name, value);
  await expect(setup()).rejects.toThrow("Local notification Cron requires");
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(mocks.query).not.toHaveBeenCalled();
});
