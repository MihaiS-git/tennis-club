import "server-only";

import { Check, Column, Entity, Index, PrimaryColumn } from "typeorm";
import { emailDeliveryStatuses, type EmailDeliveryStatus } from "@/lib/notifications/types";

@Entity({ schema: "public", name: "email_deliveries" })
@Index("email_deliveries_event_recipient_key", { synchronize: false })
@Index("email_deliveries_due_idx", ["nextAttemptAt", "id"], { where: "status IN ('pending', 'processing')" })
@Check("email_deliveries_status_check", `status IN (${emailDeliveryStatuses.map((status) => `'${status}'`).join(", ")})`)
@Check("email_deliveries_attempts_check", "attempts >= 0")
export class EmailDeliveryEntity {
  @PrimaryColumn({ type: "uuid", primaryKeyConstraintName: "email_deliveries_pkey" })
  id!: string;

  @Column({ name: "event_key", type: "text" })
  eventKey!: string;

  @Column({ name: "recipient_email", type: "text" })
  recipientEmail!: string;

  @Column({ type: "text" })
  subject!: string;

  @Column({ name: "body_text", type: "text" })
  bodyText!: string;

  @Column({ name: "body_html", type: "text" })
  bodyHtml!: string;

  @Column({ type: "text" })
  status!: EmailDeliveryStatus;

  @Column({ type: "integer", default: 0 })
  attempts!: number;

  @Column({ name: "next_attempt_at", type: "timestamptz" })
  nextAttemptAt!: Date;

  @Column({ name: "locked_until", type: "timestamptz", nullable: true })
  lockedUntil!: Date | null;

  @Column({ name: "provider_message_id", type: "text", nullable: true })
  providerMessageId!: string | null;

  @Column({ name: "last_error", type: "text", nullable: true })
  lastError!: string | null;

  @Column({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @Column({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
