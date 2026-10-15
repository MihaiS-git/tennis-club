import "server-only";
import { Check, Column, Entity, ForeignKey, Index, PrimaryColumn, Unique } from "typeorm";
import { BookingRevisionEntity } from "./booking-revision.entity";
import { BookingEntity } from "./booking.entity";
import { UserEntity } from "./user.entity";

export type AdjustmentState = "pending" | "applied" | "cancelled" | "expired" | "unsuccessful";
export type AdjustmentTarget = { courtId: string; date: string; startMinute: number; endMinute: number;
  expectedUpdatedAt: string; courtName: string; locationName: string; timezone: string };

@Entity({ schema: "public", name: "booking_adjustments" })
@Unique("booking_adjustments_identity", ["bookingId", "id"])
@Unique("booking_adjustments_request", ["bookingId", "requestKey"])
@Index("booking_adjustments_pending", ["bookingId"], { unique: true, where: "status='pending'" })
@ForeignKey(() => BookingEntity, ["bookingId"], ["id"], { name: "booking_adjustments_booking_id_fkey", onDelete: "RESTRICT" })
@ForeignKey(() => UserEntity, ["actorId"], ["id"], { name: "booking_adjustments_actor_id_fkey", onDelete: "RESTRICT" })
@Check("booking_adjustments_scope_check", "scope IN ('owner', 'admin')")
@Check("booking_adjustments_target_check", "jsonb_typeof(target) = 'object'")
@Check("booking_adjustments_target_display_check", "jsonb_typeof(target->'courtName')='string' AND jsonb_typeof(target->'locationName')='string' AND jsonb_typeof(target->'timezone')='string' AND char_length(btrim(target->>'courtName')) BETWEEN 1 AND 255 AND char_length(btrim(target->>'locationName')) BETWEEN 1 AND 255 AND char_length(btrim(target->>'timezone')) BETWEEN 1 AND 100 AND target ?& ARRAY['courtName','locationName','timezone']")
@Check("booking_adjustments_original_total_check", "original_total > 0")
@Check("booking_adjustments_new_total_check", "new_total > 0")
@Check("booking_adjustments_status_check", "status IN ('pending', 'applied', 'cancelled', 'expired', 'unsuccessful')")
@Check("booking_adjustments_expires_at_check", "isfinite(expires_at)")
@ForeignKey(() => BookingRevisionEntity, ["bookingId", "baseRevisionId"], ["bookingId", "id"], { name: "booking_adjustments_base_revision_fkey", onDelete: "RESTRICT" })
export class BookingAdjustmentEntity {
  @Column({ name: "base_revision_id", type: "uuid" }) baseRevisionId!: string;
  @PrimaryColumn({ type: "uuid", primaryKeyConstraintName: "booking_adjustments_pkey" }) id!: string;
  @Column({ name: "booking_id", type: "uuid" }) bookingId!: string;
  @Column({ name: "actor_id", type: "uuid" }) actorId!: string;
  @Column({ type: "text" }) scope!: "owner" | "admin";
  @Column({ name: "request_key", type: "text" }) requestKey!: string;
  @Column({ type: "jsonb" }) target!: AdjustmentTarget;
  @Column({ name: "original_total", type: "integer" }) originalTotal!: number;
  @Column({ name: "new_total", type: "integer" }) newTotal!: number;
  @Column({ type: "text" }) currency!: string;
  @Column({ type: "text" }) status!: AdjustmentState;
  @Column({ name: "expires_at", type: "timestamptz" }) expiresAt!: Date;
  @Column({ name: "created_at", type: "timestamptz", default: () => "now()" }) createdAt!: Date;
  @Column({ name: "updated_at", type: "timestamptz", default: () => "now()" }) updatedAt!: Date;
}
