import "server-only";

import { Check, Column, Entity, ForeignKey, Index, PrimaryColumn } from "typeorm";
import type { PaymentProvider, paymentTransition } from "@/lib/payments/domain";

import { PaymentAttemptEntity } from "./payment-attempt.entity";
import { UserEntity } from "./user.entity";

@Entity({ schema: "public", name: "payment_provider_events" })
@Index("payment_reconciliation_idx", ["attemptId"], { where: "reconciliation_required" })
@Check("payment_event_resolution_check", "(((resolved_at IS NULL) AND (resolved_by_user_id IS NULL)) OR ((resolved_at IS NOT NULL) AND (NOT reconciliation_required)))")
@Check("payment_provider_events_outcome_check", "(outcome = ANY (ARRAY['succeeded'::text, 'failed'::text, 'retryable_failed'::text, 'cancelled'::text]))")
@Check("payment_provider_events_provider_check", "(provider = ANY (ARRAY['stripe'::text, 'netopia'::text]))")
@ForeignKey(() => PaymentAttemptEntity, ["attemptId"], ["id"], { name: "payment_provider_events_attempt_id_fkey", onDelete: "CASCADE" })
@ForeignKey(() => UserEntity, ["resolvedByUserId"], ["id"], { name: "payment_provider_events_resolved_by_user_id_fkey", onDelete: "SET NULL" })
export class PaymentProviderEventEntity {
  @PrimaryColumn({ name: "provider", type: "text", primaryKeyConstraintName: "payment_provider_events_pkey" })
  provider!: PaymentProvider;

  @PrimaryColumn({ name: "event_id", type: "text", primaryKeyConstraintName: "payment_provider_events_pkey" })
  eventId!: string;

  @Column({ name: "attempt_id", type: "uuid" })
  attemptId!: string;

  @Column({ name: "provider_payment_id", type: "text" })
  providerPaymentId!: string;

  @Column({ name: "outcome", type: "text" })
  outcome!: Parameters<typeof paymentTransition>[0]["outcome"];

  @Column({ name: "settlement_result", type: "text" })
  settlementResult!: string;

  @Column({ name: "reconciliation_required", type: "boolean", default: false })
  reconciliationRequired!: boolean;

  @Column({ name: "amount_minor", type: "integer" })
  amountMinor!: number;

  @Column({ name: "currency", type: "text" })
  currency!: string;

  @Column({ name: "received_at", type: "timestamptz", default: () => "clock_timestamp()" })
  receivedAt!: Date;

  @Column({ name: "resolved_at", type: "timestamptz", nullable: true })
  resolvedAt!: Date | null;

  @Column({ name: "resolved_by_user_id", type: "uuid", nullable: true })
  resolvedByUserId!: string | null;
}
