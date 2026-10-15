import "server-only";

import { Check, Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn, Unique } from "typeorm";
import type { PaymentProvider } from "@/lib/payments/domain";
import type { LocationCurrency } from "@/lib/pricing/money";
import type { RefundStatus } from "@/lib/payments/refunds";

import { UserEntity } from "./user.entity";
import { BookingAdjustmentEntity } from "./booking-adjustment.entity";
import { BookingEntity } from "./booking.entity";
import { PaymentAttemptEntity } from "./payment-attempt.entity";
import { BookingRevisionEntity } from "./booking-revision.entity";
import { refundReasons, type RefundReason } from "@/lib/payments/refund-context";

@Entity({ schema: "public", name: "payment_refunds" })
@Check("payment_refunds_reason_check", `reason IN (${refundReasons.map(reason => `'${reason}'`).join(",")})`)
@ForeignKey(() => BookingRevisionEntity, ["bookingId", "contextRevisionId"], ["bookingId", "id"], {
  name: "payment_refunds_context_revision_fkey", onDelete: "RESTRICT", deferrable: "INITIALLY DEFERRED",
})
@Index("payment_refunds_booking_idx", ["bookingId"])
@Check("payment_refunds_captured_amount_minor_check", "captured_amount_minor > 0 AND amount_minor <= captured_amount_minor")
@Unique("payment_refunds_operation", ["paymentAttemptId", "operationKey"])
@Check("payment_refunds_amount_minor_check", "(amount_minor > 0)")
@Check("payment_refunds_provider_check", "(provider = ANY (ARRAY['stripe'::text, 'netopia'::text]))")
@Check("payment_refunds_status_check", "(status = ANY (ARRAY['pending'::text, 'pending_retry'::text, 'succeeded'::text, 'failed'::text]))")
@ForeignKey(() => BookingEntity, ["bookingId"], ["id"], { name: "payment_refunds_booking_id_fkey", onDelete: "RESTRICT" })
@ForeignKey(() => PaymentAttemptEntity, ["paymentAttemptId"], ["id"], { name: "payment_refunds_payment_attempt_id_fkey", onDelete: "RESTRICT" })
@ForeignKey(() => UserEntity, ["requestedByUserId"], ["id"], { name: "payment_refunds_requested_by_user_id_fkey", onDelete: "SET NULL" })
@ForeignKey(() => BookingAdjustmentEntity, ["adjustmentId"], ["id"], { name: "payment_refunds_adjustment_id_fkey", onDelete: "RESTRICT" })
export class PaymentRefundEntity {
  @Column({ type: "text" }) reason!: RefundReason;
  @Column({ name: "context_revision_id", type: "uuid" }) contextRevisionId!: string;
  @Column({ name: "adjustment_id", type: "uuid", nullable: true })
  adjustmentId!: string | null;

  @Column({ name: "operation_key", type: "text", default: "cancellation" })
  operationKey!: string;

  @Column({ name: "captured_amount_minor", type: "integer" })
  capturedAmountMinor!: number;

  @PrimaryGeneratedColumn("uuid", { name: "id", primaryKeyConstraintName: "payment_refunds_pkey" })
  id!: string;

  @Column({ name: "booking_id", type: "uuid" })
  bookingId!: string;

  @Column({ name: "payment_attempt_id", type: "uuid" })
  paymentAttemptId!: string;

  @Column({ name: "provider", type: "text" })
  provider!: PaymentProvider;

  @Column({ name: "provider_payment_id", type: "text" })
  providerPaymentId!: string;

  @Column({ name: "amount_minor", type: "integer" })
  amountMinor!: number;

  @Column({ name: "currency", type: "text" })
  currency!: LocationCurrency;

  @Column({ name: "status", type: "text", default: "pending" })
  status!: RefundStatus;
  @Column({ name: "requested_by_user_id", type: "uuid", nullable: true })
  requestedByUserId!: string | null;
  @Column({ name: "created_at", type: "timestamptz", default: () => "now()" })
  createdAt!: Date;

  @Column({ name: "updated_at", type: "timestamptz", default: () => "now()" })
  updatedAt!: Date;
}
