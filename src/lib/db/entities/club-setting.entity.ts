import "server-only";
import { Check, Column, Entity, PrimaryColumn } from "typeorm";

@Entity({ schema: "public", name: "club_settings" })
@Check("club_settings_singleton", "id")
@Check("club_settings_sender", "NOT emails_enabled OR (length(trim(official_email)) > 0 AND length(trim(sender_name)) > 0)")
@Check("club_settings_contact", "length(contact_email) <= 254 AND length(contact_phone) <= 30")
export class ClubSettingEntity {
  @PrimaryColumn({ type: "boolean", default: true, primaryKeyConstraintName: "club_settings_pkey" })
  id!: boolean;
  @Column({ name: "official_email", type: "text", default: "" })
  officialEmail!: string;
  @Column({ name: "sender_name", type: "text", default: "" })
  senderName!: string;
  @Column({ name: "emails_enabled", type: "boolean", default: false })
  emailsEnabled!: boolean;
  // Public club contact details; separate from the transactional sender address above.
  @Column({ name: "contact_email", type: "text", default: "" })
  contactEmail!: string;
  @Column({ name: "contact_phone", type: "text", default: "" })
  contactPhone!: string;
}
