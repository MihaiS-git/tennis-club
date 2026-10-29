import "server-only";
import { Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn, Unique } from "typeorm";
import { UserEntity } from "./user.entity";
import { CourtReservationEntity } from "./court-reservation.entity";
import { BookingRevisionEntity } from "./booking-revision.entity";

@Entity({ schema: "public", name: "checkout_records" })
@Unique("bookings_reservation_id_key", ["reservationId"])
@Index("bookings_account_user_id_idx", ["accountUserId"])
@ForeignKey(() => UserEntity, ["accountUserId"], ["id"], { name: "bookings_account_user_id_fkey", onDelete: "RESTRICT" })
@ForeignKey(() => CourtReservationEntity, ["reservationId"], ["id"], { name: "bookings_reservation_id_fkey", onDelete: "RESTRICT" })
@ForeignKey(() => BookingRevisionEntity, ["id", "currentRevisionId"], ["bookingId", "id"], { name: "bookings_current_revision_fkey", onDelete: "NO ACTION", deferrable: "INITIALLY DEFERRED" })
export class CheckoutRecordEntity {
  @PrimaryGeneratedColumn("uuid", { name: "id", primaryKeyConstraintName: "bookings_pkey" }) id!: string;
  @Column({ name: "reservation_id", type: "uuid" }) reservationId!: string;
  @Column({ name: "account_user_id", type: "uuid", nullable: true }) accountUserId!: string | null;
  @Column({ name: "current_revision_id", type: "uuid" }) currentRevisionId!: string;
  @Column({ type: "enum", default: "confirmed", enumName: "booking_status", enum: ["confirmed", "cancelled", "pending_payment", "failed", "expired"] })
  status!: "confirmed" | "cancelled" | "pending_payment" | "failed" | "expired";
  @Column({ name: "created_at", type: "timestamptz", default: () => "now()" }) createdAt!: Date;
  @Column({ name: "updated_at", type: "timestamptz", default: () => "now()" }) updatedAt!: Date;
}
