import "server-only";

import { Check, Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn, Unique } from "typeorm";
import type { PaymentProvider } from "@/lib/payments/domain";
import type { LocationCurrency } from "@/lib/pricing/money";
import { PaymentRefundEntity } from "./payment-refund.entity";
import { UserEntity } from "./user.entity";

export type RefundExecutionStatus = "ready" | "pending" | "uncertain" | "succeeded" | "failed" | "rejected";
export type RefundExecutionTerminalResult = Extract<RefundExecutionStatus, "succeeded" | "failed" | "rejected">;

@Entity({ schema: "public", name: "refund_executions" })
@ForeignKey(() => PaymentRefundEntity, ["refundId"], ["id"], { name: "refund_executions_refund_fkey", onDelete: "RESTRICT" })
@ForeignKey(() => UserEntity, ["initiatedByUserId"], ["id"], { name: "refund_executions_initiator_fkey", onDelete: "RESTRICT" })
@Unique("refund_executions_number_key", ["refundId", "executionNumber"])
@Unique("refund_executions_idempotency_key", ["provider", "idempotencyKey"])
@Unique("refund_executions_provider_refund_key", ["provider", "providerRefundId"])
@Index("refund_executions_one_active", ["refundId"], { unique: true, where: "status NOT IN ('failed', 'rejected')" })
@Check("refund_executions_number_check", "execution_number > 0")
@Check("refund_executions_amount_check", "amount_minor > 0")
@Check("refund_executions_provider_check", "provider IN ('stripe', 'netopia')")
@Check("refund_executions_currency_check", "currency IN ('EUR', 'USD', 'GBP', 'RON', 'CHF')")
@Check("refund_executions_request_check", "char_length(btrim(provider_payment_id)) > 0 AND char_length(btrim(idempotency_key)) > 0")
@Check("refund_executions_status_check", "status IN ('ready', 'pending', 'uncertain', 'succeeded', 'failed', 'rejected')")
@Check("refund_executions_lease_check", "(lease_token IS NULL) = (lease_until IS NULL) AND (lease_until IS NULL OR isfinite(lease_until))")
@Check("refund_executions_uncertainty_check", `(first_uncertain_at IS NULL) = (first_uncertainty_evidence IS NULL)
  AND (first_uncertainty_evidence IS NULL OR char_length(btrim(first_uncertainty_evidence)) > 0)
  AND (status <> 'uncertain' OR first_uncertain_at IS NOT NULL)`)
@Check("refund_executions_terminal_check", `
  (terminal_result IS NULL AND terminal_evidence IS NULL AND completed_at IS NULL AND status IN ('ready', 'pending', 'uncertain'))
  OR (terminal_result IS NOT NULL AND terminal_result IN ('succeeded', 'failed', 'rejected')
    AND status = terminal_result AND terminal_evidence IS NOT NULL AND char_length(btrim(terminal_evidence)) > 0
    AND completed_at IS NOT NULL AND dispatch_initiated_at IS NOT NULL
    AND ((terminal_result = 'rejected' AND provider_refund_id IS NULL)
      OR (terminal_result IN ('succeeded', 'failed') AND provider_refund_id IS NOT NULL)))`)
@Check("refund_executions_dispatch_check", `(status = 'ready' AND dispatch_initiated_at IS NULL
    AND provider_refund_id IS NULL AND first_uncertain_at IS NULL)
  OR (status <> 'ready' AND dispatch_initiated_at IS NOT NULL)`)
@Check("refund_executions_provider_identity_check", "provider_refund_id IS NULL OR char_length(btrim(provider_refund_id)) > 0")
@Check("refund_executions_time_check", `isfinite(created_at) AND isfinite(updated_at)
  AND (dispatch_initiated_at IS NULL OR isfinite(dispatch_initiated_at))
  AND (first_uncertain_at IS NULL OR isfinite(first_uncertain_at))
  AND (completed_at IS NULL OR isfinite(completed_at))
  AND (last_checked_at IS NULL OR isfinite(last_checked_at))`)
export class RefundExecutionEntity {
  @PrimaryGeneratedColumn("uuid", { primaryKeyConstraintName: "refund_executions_pkey" }) id!: string;
  @Column({ name: "refund_id", type: "uuid" }) refundId!: string;
  @Column({ name: "execution_number", type: "integer" }) executionNumber!: number;
  @Column({ type: "text" }) provider!: PaymentProvider;
  @Column({ name: "provider_payment_id", type: "text" }) providerPaymentId!: string;
  @Column({ name: "amount_minor", type: "integer" }) amountMinor!: number;
  @Column({ type: "text" }) currency!: LocationCurrency;
  @Column({ name: "idempotency_key", type: "text" }) idempotencyKey!: string;
  @Column({ name: "initiated_by_user_id", type: "uuid", nullable: true }) initiatedByUserId!: string | null;
  @Column({ name: "created_at", type: "timestamptz", default: () => "now()" }) createdAt!: Date;

  @Column({ name: "dispatch_initiated_at", type: "timestamptz", nullable: true }) dispatchInitiatedAt!: Date | null;
  @Column({ name: "provider_refund_id", type: "text", nullable: true }) providerRefundId!: string | null;
  @Column({ name: "first_uncertain_at", type: "timestamptz", nullable: true }) firstUncertainAt!: Date | null;
  @Column({ name: "first_uncertainty_evidence", type: "text", nullable: true }) firstUncertaintyEvidence!: string | null;
  @Column({ name: "terminal_result", type: "text", nullable: true }) terminalResult!: RefundExecutionTerminalResult | null;
  @Column({ name: "terminal_evidence", type: "text", nullable: true }) terminalEvidence!: string | null;
  @Column({ name: "completed_at", type: "timestamptz", nullable: true }) completedAt!: Date | null;

  @Column({ type: "text", default: "ready" }) status!: RefundExecutionStatus;
  @Column({ name: "lease_token", type: "uuid", nullable: true }) leaseToken!: string | null;
  @Column({ name: "lease_until", type: "timestamptz", nullable: true }) leaseUntil!: Date | null;
  @Column({ name: "last_checked_at", type: "timestamptz", nullable: true }) lastCheckedAt!: Date | null;
  @Column({ name: "last_error", type: "text", nullable: true }) lastError!: string | null;
  @Column({ name: "updated_at", type: "timestamptz", default: () => "now()" }) updatedAt!: Date;
}
