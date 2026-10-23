import { expect, test, vi } from "vitest";
import type { EntityManager, QueryRunner } from "typeorm";
import { readClubSettings, writeClubSettings, emailDispatchAllowed } from "@/lib/db/repositories/club-settings.repository";
import { ClubSettings1791462257927 } from "@/lib/db/migrations/1791462257927-ClubSettings";

const settings = { officialEmail: "official@example.com", senderName: "Club", emailsEnabled: false };
function fixture() {
  const builder = { where: vi.fn().mockReturnThis(), setLock: vi.fn().mockReturnThis(), getOneOrFail: vi.fn().mockResolvedValue({ id: true, ...settings }) };
  const update = vi.fn();
  const query = vi.fn().mockResolvedValue([]);
  const manager = { getRepository: () => ({ createQueryBuilder: () => builder, update }), query } as unknown as EntityManager;
  return { builder, manager, update, query };
}

test("singleton reads return only form settings; writes lock and suppress without deleting history", async () => {
  const { manager, builder, update, query } = fixture();
  expect(await readClubSettings(manager)).toEqual(settings);
  await writeClubSettings(manager, settings);
  expect(builder.setLock).toHaveBeenCalledWith("pessimistic_write");
  expect(query).toHaveBeenCalledWith(expect.stringContaining("suppressed_at IS NULL AND status IN ('pending','processing','failed')"));
  expect(update).toHaveBeenCalledWith({ id: true }, settings);
  query.mockClear();
  await writeClubSettings(manager, { ...settings, emailsEnabled: true });
  expect(query).not.toHaveBeenCalled(); // Re-enabling never clears suppression.
});

test("dispatch checks both current switch and durable suppression", async () => {
  const { manager, builder, query } = fixture();
  expect(await emailDispatchAllowed(manager, "delivery")).toBeNull();
  expect(query).not.toHaveBeenCalled();
  builder.getOneOrFail.mockResolvedValue({ id: true, ...settings, emailsEnabled: true });
  expect(await emailDispatchAllowed(manager, "delivery")).toBeNull();
  expect(query).toHaveBeenCalledWith(expect.stringContaining("suppressed_at IS NULL"), ["delivery"]);
  query.mockResolvedValue([{ id: "delivery" }]);
  expect(await emailDispatchAllowed(manager, "delivery")).toMatchObject({ emailsEnabled: true });
});

test("additive migration seeds disabled singleton, denies browser grants and suppresses old pending records", async () => {
  const query = vi.fn();
  await new ClubSettings1791462257927().up({ query } as unknown as QueryRunner);
  const sql = query.mock.calls.flat().join("\n");
  expect(sql).toContain("emails_enabled boolean NOT NULL DEFAULT false");
  expect(sql).toContain("FROM PUBLIC, anon, authenticated");
  expect(sql).toContain("ALTER TABLE public.email_deliveries ADD COLUMN suppressed_at");
  expect(sql).toContain("WHERE status IN ('pending','processing','failed')");
  expect(sql).not.toMatch(/DELETE|DROP|TRUNCATE/);
});
