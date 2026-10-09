import "server-only";

import { Check, Column, Entity, ForeignKey, Index, PrimaryColumn, Unique } from "typeorm";
import type { LocationCurrency } from "@/lib/pricing/money";
import type { PaymentMethod } from "@/lib/payments/domain";

import { UserEntity } from "./user.entity";
import { CourtReservationEntity } from "./court-reservation.entity";

@Entity({ schema: "public", name: "bookings" })
@Unique("bookings_reservation_id_key", ["reservationId"])
@Index("bookings_account_user_id_idx", ["accountUserId"])
@Check("bookings_amount_check", "(total_amount_minor > 0)")
@Check("bookings_cancellation_notice_check", "((cancellation_notice_minutes >= 0) AND (cancellation_notice_minutes <= 43200))")
@Check("bookings_currency_check", "(currency = ANY (ARRAY['EUR'::text, 'USD'::text, 'GBP'::text, 'RON'::text, 'CHF'::text]))")
@Check("bookings_customer_email_check", "((char_length(customer_email) <= 320) AND (char_length(btrim(customer_email)) > 0))")
@Check("bookings_customer_name_check", "((char_length(customer_name) <= 200) AND (char_length(btrim(customer_name)) > 0))")
@Check("bookings_customer_phone_check", "((char_length(customer_phone) <= 50) AND (char_length(btrim(customer_phone)) > 0))")
@Check("bookings_payment_method_check", "(payment_method = ANY (ARRAY['online'::text, 'pay_at_club'::text]))")
@Check("bookings_pending_payment_method_check", "((status <> 'pending_payment'::public.booking_status) OR ((payment_method = 'online'::text) AND (payment_method IS NOT NULL)))")
@ForeignKey(() => UserEntity, ["accountUserId"], ["id"], { name: "bookings_account_user_id_fkey", onDelete: "RESTRICT" })
@ForeignKey(() => CourtReservationEntity, ["reservationId"], ["id"], { name: "bookings_reservation_id_fkey", onDelete: "RESTRICT" })
export class BookingEntity {
  @PrimaryColumn({ name: "id", type: "uuid", default: () => "gen_random_uuid()", primaryKeyConstraintName: "bookings_pkey" })
  id!: string;

  @Column({ name: "reservation_id", type: "uuid" })
  reservationId!: string;

  @Column({ name: "account_user_id", type: "uuid", nullable: true })
  accountUserId!: string | null;

  @Column({ name: "customer_name", type: "text" })
  customerName!: string;

  @Column({ name: "customer_email", type: "text" })
  customerEmail!: string;

  @Column({ name: "customer_phone", type: "text" })
  customerPhone!: string;

  @Column({ name: "status", type: "enum", default: () => "'confirmed'", enumName: "booking_status", enum: ["confirmed", "cancelled", "pending_payment", "failed", "expired"] })
  status!: "confirmed" | "cancelled" | "pending_payment" | "failed" | "expired";

  @Column({ name: "total_amount_minor", type: "integer" })
  totalAmountMinor!: number;

  @Column({ name: "currency", type: "text" })
  currency!: LocationCurrency;

  @Column({ name: "created_at", type: "timestamptz", default: () => "now()" })
  createdAt!: Date;

  @Column({ name: "updated_at", type: "timestamptz", default: () => "now()" })
  updatedAt!: Date;

  @Column({ name: "cancellation_notice_minutes", type: "integer" })
  cancellationNoticeMinutes!: number;

  @Column({ name: "payment_method", type: "text", nullable: true })
  paymentMethod!: PaymentMethod | null;
}
