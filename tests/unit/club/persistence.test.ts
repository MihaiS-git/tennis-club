import { expect, test, vi } from "vitest";
import type { EntityManager } from "typeorm";
import { readClubContact, readClubSettings, writeClubContact, writeClubSettings, emailDispatchAllowed } from "@/lib/db/repositories/club-settings.repository";

const settings = { officialEmail: "official@example.com", senderName: "Club", emailsEnabled: false };
function fixture() {
  const builder = { select: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), setLock: vi.fn().mockReturnThis(), getOneOrFail: vi.fn().mockResolvedValue({ id: true, ...settings, contactEmail: "hello@example.com", contactPhone: "+40 21 123 4567" }) };
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

test("public contact reads select only contact columns and writes never touch email delivery", async () => {
  const { manager, builder, update, query } = fixture();
  expect(await readClubContact(manager)).toEqual({ contactEmail: "hello@example.com", contactPhone: "+40 21 123 4567" });
  expect(builder.select).toHaveBeenCalledWith(["settings.id", "settings.contactEmail", "settings.contactPhone"]);
  await writeClubContact(manager, { contactEmail: "", contactPhone: "+40 21 123 4567" });
  expect(update).toHaveBeenCalledWith({ id: true }, { contactEmail: "", contactPhone: "+40 21 123 4567" });
  expect(query).not.toHaveBeenCalled();
});
