import "server-only";

import { Check, Column, Entity, ForeignKey, PrimaryColumn, Unique } from "typeorm";
import type { PaymentProvider } from "@/lib/payments/domain";
import type { LocationCurrency } from "@/lib/pricing/money";
import type { RefundStatus } from "@/lib/payments/refunds";

import { UserEntity } from "./user.entity";
import { BookingEntity } from "./booking.entity";
import { PaymentAttemptEntity } from "./payment-attempt.entity";

@Entity({ schema: "public", name: "payment_refunds" })
@Unique("payment_refunds_booking_id_key", ["bookingId"])
@Unique("payment_refunds_payment_attempt_id_key", ["paymentAttemptId"])
@Unique("payment_refunds_provider_refund_id_key", ["providerRefundId"])
@Check("payment_refunds_amount_minor_check", "(amount_minor > 0)")
@Check("payment_refunds_provider_check", "(provider = ANY (ARRAY['stripe'::text, 'netopia'::text]))")
@Check("payment_refunds_status_check", "(status = ANY (ARRAY['pending'::text, 'pending_retry'::text, 'succeeded'::text, 'failed'::text]))")
@ForeignKey(() => UserEntity, ["adminLeaseActorId"], ["id"], { name: "payment_refunds_admin_lease_actor_id_fkey", onDelete: "SET NULL" })
@ForeignKey(() => BookingEntity, ["bookingId"], ["id"], { name: "payment_refunds_booking_id_fkey", onDelete: "CASCADE" })
@ForeignKey(() => PaymentAttemptEntity, ["paymentAttemptId"], ["id"], { name: "payment_refunds_payment_attempt_id_fkey", onDelete: "CASCADE" })
@ForeignKey(() => UserEntity, ["requestedByUserId"], ["id"], { name: "payment_refunds_requested_by_user_id_fkey", onDelete: "SET NULL" })
export class PaymentRefundEntity {
  @PrimaryColumn({ name: "id", type: "uuid", default: () => "gen_random_uuid()", primaryKeyConstraintName: "payment_refunds_pkey" })
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

  @Column({ name: "provider_refund_id", type: "text", nullable: true })
  providerRefundId!: string | null;

  @Column({ name: "requested_by_user_id", type: "uuid", nullable: true })
  requestedByUserId!: string | null;

  @Column({ name: "last_error", type: "text", nullable: true })
  lastError!: string | null;

  @Column({ name: "created_at", type: "timestamptz", default: () => "now()" })
  createdAt!: Date;

  @Column({ name: "updated_at", type: "timestamptz", default: () => "now()" })
  updatedAt!: Date;

  @Column({ name: "admin_lease_token", type: "uuid", nullable: true })
  adminLeaseToken!: string | null;

  @Column({ name: "admin_lease_until", type: "timestamptz", nullable: true })
  adminLeaseUntil!: Date | null;

  @Column({ name: "admin_lease_actor_id", type: "uuid", nullable: true })
  adminLeaseActorId!: string | null;
}
