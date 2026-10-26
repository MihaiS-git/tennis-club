import type { EntityManager } from "typeorm";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admins: vi.fn() }));
vi.mock("@/lib/db/transaction", () => ({ inTransaction: vi.fn() }));
vi.mock("@/lib/db/repositories/club-settings.repository", () => ({ readClubSettings: vi.fn(), emailDispatchAllowed: vi.fn() }));
// Inserts run through the real batched repository method against a recording query builder.
vi.mock("@/lib/db/repositories/notifications.repository", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/db/repositories/notifications.repository")>(),
  listActiveUserIdsWithRole: mocks.admins,
}));

import { recordEmailFailureAlerts } from "@/lib/notifications/delivery";

const occurredAt = new Date("2026-10-26T10:00:00Z");
const first = "00000000-0000-4000-8000-00000000000a";
const second = "00000000-0000-4000-8000-00000000000b";
const content = { kind: "email.delivery_failed", subject: "Booking email delivery failed",
  bodyText: "An outbound booking email could not be delivered. Open Delivery details to review the failure and retry eligibility.",
  href: null, createdAt: occurredAt, readAt: null, deletedAt: null };

function recordingManager() {
  const execute = vi.fn().mockResolvedValue({});
  const builder = { insert: vi.fn(), values: vi.fn(), orIgnore: vi.fn(), execute };
  for (const step of [builder.insert, builder.values, builder.orIgnore]) step.mockReturnValue(builder);
  const manager = { getRepository: vi.fn().mockReturnValue({ createQueryBuilder: () => builder }) } as unknown as EntityManager;
  const rows = () => builder.values.mock.calls.flatMap(call => call[0] as { id: string; userId: string; eventKey: string }[]);
  return { manager, builder, execute, rows };
}

beforeEach(() => { vi.clearAllMocks(); });

test("one Admin and one delivery receive one in-app alert with unchanged identity and content", async () => {
  mocks.admins.mockResolvedValue(["admin-1"]);
  const { manager, execute, rows, builder } = recordingManager();
  await recordEmailFailureAlerts(manager, [first], occurredAt);
  expect(mocks.admins).toHaveBeenCalledExactlyOnceWith(manager, "admin");
  expect(execute).toHaveBeenCalledOnce();
  expect(builder.orIgnore).toHaveBeenCalledOnce();
  expect(rows()).toEqual([{ id: expect.any(String), userId: "admin-1", eventKey: `email.delivery-failed:${first}`, ...content }]);
});

test("multiple deliveries and Admins share one insert in a stable order; duplicate IDs collapse", async () => {
  mocks.admins.mockResolvedValue(["admin-1", "admin-2"]);
  const { manager, execute, rows } = recordingManager();
  await recordEmailFailureAlerts(manager, [second, first, second], occurredAt);
  expect(mocks.admins).toHaveBeenCalledOnce();
  expect(execute).toHaveBeenCalledOnce();
  expect(rows().map(row => [row.userId, row.eventKey])).toEqual([
    ["admin-1", `email.delivery-failed:${first}`], ["admin-2", `email.delivery-failed:${first}`],
    ["admin-1", `email.delivery-failed:${second}`], ["admin-2", `email.delivery-failed:${second}`]]);
  expect(new Set(rows().map(row => row.id)).size).toBe(4);
});

test("no deliveries skip recipient lookup and no eligible Admins issue no insert", async () => {
  const { manager, execute } = recordingManager();
  await recordEmailFailureAlerts(manager, [], occurredAt);
  expect(mocks.admins).not.toHaveBeenCalled();
  mocks.admins.mockResolvedValue([]);
  await recordEmailFailureAlerts(manager, [first, second], occurredAt);
  expect(mocks.admins).toHaveBeenCalledOnce();
  expect(execute).not.toHaveBeenCalled();
});

test("large recipient sets keep the bounded repository batch size", async () => {
  mocks.admins.mockResolvedValue(Array.from({ length: 600 }, (_, index) => `admin-${index}`));
  const { manager, execute, builder } = recordingManager();
  await recordEmailFailureAlerts(manager, [first, second], occurredAt);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(builder.values.mock.calls.map(call => call[0].length)).toEqual([1000, 200]);
});

test("recipient lookup failure propagates before any insert", async () => {
  mocks.admins.mockRejectedValue(new Error("lookup failed"));
  const { manager, execute } = recordingManager();
  await expect(recordEmailFailureAlerts(manager, [first], occurredAt)).rejects.toThrow("lookup failed");
  expect(execute).not.toHaveBeenCalled();
});
