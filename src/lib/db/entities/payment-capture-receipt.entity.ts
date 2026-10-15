import "server-only";

import { Check, Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn, Unique } from "typeorm";
import type { LocationCurrency } from "@/lib/pricing/money";
import type { PaymentProvider } from "@/lib/payments/domain";

import { PaymentAttemptEntity } from "./payment-attempt.entity";

@Entity({ schema: "public", name: "payment_capture_receipts" })
@Index("payment_capture_receipts_attempt_idx", ["paymentAttemptId"])
@Index("payment_capture_receipts_provider_capture", ["provider", "providerCaptureId"], { unique: true })
@Unique("payment_capture_receipts_attempt_identity", ["paymentAttemptId", "id"])
@Check("payment_capture_receipts_provider_check", "provider IN ('stripe','netopia')")
@Check("payment_capture_receipts_amount_check", "amount_minor > 0")
@Check("payment_capture_receipts_currency_check", "currency IN ('EUR','USD','GBP','RON','CHF')")
@Check("payment_capture_receipts_identity_check", "char_length(provider_payment_id) BETWEEN 1 AND 255 AND char_length(provider_capture_id) BETWEEN 1 AND 255")
@Check("payment_capture_receipts_observation_check", "isfinite(first_observed_at) AND isfinite(last_observed_at) AND last_observed_at >= first_observed_at")
@ForeignKey(() => PaymentAttemptEntity, ["paymentAttemptId"], ["id"], {
  name: "payment_capture_receipts_attempt_fkey", onDelete: "RESTRICT",
})
export class PaymentCaptureReceiptEntity {
  @PrimaryGeneratedColumn("uuid", { name: "id", primaryKeyConstraintName: "payment_capture_receipts_pkey" })
  id!: string;

  @Column({ name: "payment_attempt_id", type: "uuid" })
  paymentAttemptId!: string;

  @Column({ name: "provider", type: "text" })
  provider!: PaymentProvider;

  @Column({ name: "provider_payment_id", type: "text" })
  providerPaymentId!: string;

  @Column({ name: "provider_capture_id", type: "text" })
  providerCaptureId!: string;

  @Column({ name: "amount_minor", type: "integer" })
  amountMinor!: number;

  @Column({ name: "currency", type: "text" })
  currency!: LocationCurrency;

  @Column({ name: "first_observed_at", type: "timestamptz", default: () => "clock_timestamp()" })
  firstObservedAt!: Date;

  @Column({ name: "last_observed_at", type: "timestamptz", default: () => "clock_timestamp()" })
  lastObservedAt!: Date;
}
