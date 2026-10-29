import "server-only";
import { Entity, ForeignKey, PrimaryColumn, Column } from "typeorm";
import { CheckoutRecordEntity } from "./checkout-record.entity";
import { BookingRevisionEntity } from "./booking-revision.entity";

// Created only on genuine confirmation, in the same transaction as occupancy.
// Checkout/payment evidence belongs to checkout_records, even if no booking exists.
@Entity({ schema: "public", name: "bookings" })
@ForeignKey(() => CheckoutRecordEntity, ["id"], ["id"], { name: "confirmed_booking_checkout_fkey", onDelete: "RESTRICT" })
@ForeignKey(() => BookingRevisionEntity, ["id", "confirmationRevisionId"], ["bookingId", "id"], { name: "confirmed_booking_revision_fkey", onDelete: "RESTRICT" })
export class BookingEntity {
  @PrimaryColumn({ type: "uuid", primaryKeyConstraintName: "confirmed_bookings_pkey" }) id!: string;
  @Column({ name: "confirmation_revision_id", type: "uuid" }) confirmationRevisionId!: string;
}
