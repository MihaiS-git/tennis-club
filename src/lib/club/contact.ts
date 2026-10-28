import "server-only";
import { getDataSource } from "@/lib/db/data-source";
import { readClubContact } from "@/lib/db/repositories/club-settings.repository";
import { clubContactSchema, type ClubContact } from "./schema";

// The club's public telephone number and email address. Values that no longer pass
// validation are withheld rather than published; empty values are not shown.
export async function readPublicClubContact(): Promise<ClubContact> {
  const contact = await readClubContact((await getDataSource()).manager);
  return {
    contactEmail: clubContactSchema.shape.contactEmail.safeParse(contact.contactEmail).data ?? "",
    contactPhone: clubContactSchema.shape.contactPhone.safeParse(contact.contactPhone).data ?? "",
  };
}
