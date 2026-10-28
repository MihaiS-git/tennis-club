import "server-only";
import type { EntityManager } from "typeorm";
import { ClubSettingEntity } from "../entities/club-setting.entity";
import type { ClubContact, ClubSettings } from "@/lib/club/schema";

export async function readClubSettings(manager: EntityManager, lock?: "pessimistic_read" | "pessimistic_write"): Promise<ClubSettings> {
  const query = manager.getRepository(ClubSettingEntity).createQueryBuilder("settings").where("settings.id = true");
  if (lock) query.setLock(lock);
  const settings = await query.getOneOrFail();
  return { officialEmail: settings.officialEmail, senderName: settings.senderName, emailsEnabled: settings.emailsEnabled };
}

export async function writeClubSettings(manager: EntityManager, settings: ClubSettings) {
  await readClubSettings(manager, "pessimistic_write");
  if (!settings.emailsEnabled) {
    await manager.query(`UPDATE public.email_deliveries SET suppressed_at=clock_timestamp()
      WHERE suppressed_at IS NULL AND status IN ('pending','processing','failed')`);
  }
  await manager.getRepository(ClubSettingEntity).update({ id: true }, settings);
}

export async function readClubContact(manager: EntityManager): Promise<ClubContact> {
  const settings = await manager.getRepository(ClubSettingEntity).createQueryBuilder("settings")
    .select(["settings.id", "settings.contactEmail", "settings.contactPhone"]).where("settings.id = true").getOneOrFail();
  return { contactEmail: settings.contactEmail, contactPhone: settings.contactPhone };
}

// Contact details are written alone so a save never touches transactional email delivery.
export async function writeClubContact(manager: EntityManager, contact: ClubContact) {
  await manager.getRepository(ClubSettingEntity).update({ id: true },
    { contactEmail: contact.contactEmail, contactPhone: contact.contactPhone });
}

export async function emailDispatchAllowed(manager: EntityManager, id: string) {
  const settings = await readClubSettings(manager, "pessimistic_read");
  if (!settings.emailsEnabled) return null;
  const rows: unknown[] = await manager.query(`SELECT id FROM public.email_deliveries
    WHERE id=$1 AND status='processing' AND suppressed_at IS NULL AND provider_message_id IS NULL`, [id]);
  return rows.length ? settings : null;
}
