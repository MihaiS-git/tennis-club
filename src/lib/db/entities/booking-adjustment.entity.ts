import "server-only";
import { Column, Entity, ForeignKey, Index, PrimaryColumn } from "typeorm";
import { BookingEntity } from "./booking.entity";
import { UserEntity } from "./user.entity";

export type AdjustmentState = "pending" | "applied" | "cancelled" | "expired" | "unsuccessful";
export type AdjustmentTarget = { courtId: string; date: string; startMinute: number; endMinute: number;
  expectedUpdatedAt: string; expectedBookingUpdatedAt: string; expectedTotal: number;
  original?: { courtId: string; date: string; startMinute: number; endMinute: number; cancellationNoticeMinutes: number; refundDecision: boolean } };

@Entity({ schema: "public", name: "booking_adjustments" })
@Index("booking_adjustments_request", ["bookingId", "requestKey"], { unique: true })
@Index("booking_adjustments_pending", ["bookingId"], { unique: true, where: "status='pending'" })
@ForeignKey(() => BookingEntity, ["bookingId"], ["id"], { onDelete: "CASCADE" })
@ForeignKey(() => UserEntity, ["actorId"], ["id"], { onDelete: "RESTRICT" })
export class BookingAdjustmentEntity {
  @PrimaryColumn({ type: "uuid" }) id!: string;
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
