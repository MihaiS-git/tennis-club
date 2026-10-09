import "server-only";

import { Check, Column, Entity, Exclusion, ForeignKey, Index, PrimaryColumn } from "typeorm";

import { UserEntity } from "./user.entity";
import { CourtEntity } from "./court.entity";

@Entity({ schema: "public", name: "court_reservations" })
@Index("court_reservations_personal_owner_idx", ["createdByUserId"], { where: "(created_by_user_id IS NOT NULL)" })
@Index("payment_holds_expiry_idx", ["courtId", "holdExpiresAt"], { where: "(status = 'held'::public.court_reservation_status)" })
@Check("court_reservation_cancellation_check", "(((status = ANY (ARRAY['active'::public.court_reservation_status, 'held'::public.court_reservation_status, 'released'::public.court_reservation_status])) AND (cancelled_at IS NULL) AND (cancelled_by_user_id IS NULL)) OR ((status = 'cancelled'::public.court_reservation_status) AND (cancelled_at IS NOT NULL) AND (cancelled_by_user_id IS NOT NULL)))")
@Check("court_reservation_hold_check", "(((status = 'held'::public.court_reservation_status) AND (hold_expires_at IS NOT NULL) AND isfinite(hold_expires_at)) OR ((status <> 'held'::public.court_reservation_status) AND (hold_expires_at IS NULL)))")
@Check("court_reservation_reason_check", "((reason IS NULL) OR ((char_length(reason) <= 255) AND (char_length(btrim(reason)) > 0)))")
@Check("court_reservation_time_check", "(((starts_at_minute % 30) = 0) AND ((ends_at_minute % 30) = 0) AND ((ends_at_minute - starts_at_minute) >= 60))")
@Check("court_reservations_booking_date_check", "isfinite(booking_date)")
@Check("court_reservations_ends_at_minute_check", "((ends_at_minute >= 1) AND (ends_at_minute <= 1440))")
@Check("court_reservations_starts_at_minute_check", "((starts_at_minute >= 0) AND (starts_at_minute <= 1439))")
@ForeignKey(() => UserEntity, ["cancelledByUserId"], ["id"], { name: "court_reservations_cancelled_by_user_id_fkey", onDelete: "RESTRICT" })
@ForeignKey(() => CourtEntity, ["courtId"], ["id"], { name: "court_reservations_court_id_fkey", onDelete: "NO ACTION" })
@ForeignKey(() => UserEntity, ["createdByUserId"], ["id"], { name: "court_reservations_created_by_user_id_fkey", onDelete: "RESTRICT" })
// Explicit SQL and a final cutover decision are required; no entity overlap hooks.
@Exclusion("court_reservation_no_overlap", "USING gist (court_id WITH =, booking_date WITH =, int4range(starts_at_minute, ends_at_minute, '[)') WITH &&) WHERE (status IN ('active', 'held'))")
export class CourtReservationEntity {
  @PrimaryColumn({ name: "id", type: "uuid", default: () => "gen_random_uuid()", primaryKeyConstraintName: "court_reservations_pkey" })
  id!: string;

  @Column({ name: "court_id", type: "uuid" })
  courtId!: string;

  @Column({ name: "booking_date", type: "date" })
  bookingDate!: string;

  @Column({ name: "starts_at_minute", type: "integer" })
  startsAtMinute!: number;

  @Column({ name: "ends_at_minute", type: "integer" })
  endsAtMinute!: number;

  @Column({ name: "created_at", type: "timestamptz", default: () => "now()" })
  createdAt!: Date;

  @Column({ name: "updated_at", type: "timestamptz", default: () => "now()" })
  updatedAt!: Date;

  @Column({ name: "reason", type: "text", nullable: true })
  reason!: string | null;

  @Column({ name: "created_by_user_id", type: "uuid", nullable: true })
  createdByUserId!: string | null;

  @Column({ name: "status", type: "enum", default: () => "'active'", enumName: "court_reservation_status", enum: ["active", "cancelled", "held", "released"] })
  status!: "active" | "cancelled" | "held" | "released";

  @Column({ name: "cancelled_at", type: "timestamptz", nullable: true })
  cancelledAt!: Date | null;

  @Column({ name: "cancelled_by_user_id", type: "uuid", nullable: true })
  cancelledByUserId!: string | null;

  @Column({ name: "hold_expires_at", type: "timestamptz", nullable: true })
  holdExpiresAt!: Date | null;
}
