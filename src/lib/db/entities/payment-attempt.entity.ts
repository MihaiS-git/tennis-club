import "server-only";

import { Check, Column, Entity, ForeignKey, Index, PrimaryColumn } from "typeorm";
import type { LocationCurrency } from "@/lib/pricing/money";
import type { PaymentMethod, PaymentProvider } from "@/lib/payments/domain";

import { BookingEntity } from "./booking.entity";

@Entity({ schema: "public", name: "payment_attempts" })
@Index("payment_attempts_booking_idx", ["bookingId"])
@Index("payment_attempts_one_pending", ["bookingId"], { unique: true, where: "(status = 'pending'::text)" })
@Index("payment_attempts_provider_id", ["provider", "providerPaymentId"], { unique: true, where: "(provider_payment_id IS NOT NULL)" })
@Index("payment_checkout_token_idx", ["checkoutTokenHash"], { unique: true, where: "(checkout_token_hash IS NOT NULL)" })
@Check("payment_attempt_completion_check", "(((status = ANY (ARRAY['pending'::text, 'due'::text])) AND (completed_at IS NULL)) OR ((status = ANY (ARRAY['succeeded'::text, 'failed'::text, 'cancelled'::text, 'expired'::text])) AND (completed_at IS NOT NULL)))")
@Check("payment_attempt_method_check", "(((method = 'online'::text) AND (provider IS NOT NULL) AND (status <> 'due'::text) AND (expires_at IS NOT NULL) AND isfinite(expires_at)) OR ((method = 'pay_at_club'::text) AND (provider IS NULL) AND (provider_payment_id IS NULL) AND (status = 'due'::text) AND (expires_at IS NULL)))")
@Check("payment_attempts_amount_minor_check", "(amount_minor > 0)")
@Check("payment_attempts_currency_check", "(currency = ANY (ARRAY['EUR'::text, 'USD'::text, 'GBP'::text, 'RON'::text, 'CHF'::text]))")
@Check("payment_attempts_method_check", "(method = ANY (ARRAY['online'::text, 'pay_at_club'::text]))")
@Check("payment_attempts_provider_check", "(provider = ANY (ARRAY['stripe'::text, 'netopia'::text]))")
@Check("payment_attempts_provider_payment_id_check", "((char_length(provider_payment_id) >= 1) AND (char_length(provider_payment_id) <= 255))")
@Check("payment_attempts_status_check", "(status = ANY (ARRAY['pending'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text, 'expired'::text, 'due'::text]))")
@ForeignKey(() => BookingEntity, ["bookingId"], ["id"], { name: "payment_attempts_booking_id_fkey", onDelete: "CASCADE" })
export class PaymentAttemptEntity {
  @PrimaryColumn({ name: "id", type: "uuid", default: () => "gen_random_uuid()", primaryKeyConstraintName: "payment_attempts_pkey" })
  id!: string;

  @Column({ name: "booking_id", type: "uuid" })
  bookingId!: string;

  @Column({ name: "method", type: "text" })
  method!: PaymentMethod;

  @Column({ name: "provider", type: "text", nullable: true })
  provider!: PaymentProvider | null;

  @Column({ name: "provider_payment_id", type: "text", nullable: true })
  providerPaymentId!: string | null;

  @Column({ name: "amount_minor", type: "integer" })
  amountMinor!: number;

  @Column({ name: "currency", type: "text" })
  currency!: LocationCurrency;

  @Column({ name: "status", type: "text" })
  status!: "pending" | "succeeded" | "failed" | "cancelled" | "expired" | "due";

  @Column({ name: "expires_at", type: "timestamptz", nullable: true })
  expiresAt!: Date | null;

  @Column({ name: "created_at", type: "timestamptz", default: () => "now()" })
  createdAt!: Date;

  @Column({ name: "updated_at", type: "timestamptz", default: () => "now()" })
  updatedAt!: Date;

  @Column({ name: "completed_at", type: "timestamptz", nullable: true })
  completedAt!: Date | null;

  @Column({ name: "checkout_token_hash", type: "text", nullable: true })
  checkoutTokenHash!: string | null;
}
