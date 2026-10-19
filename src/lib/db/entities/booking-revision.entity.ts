import "server-only";
import { Check, Column, Entity, ForeignKey, Index, PrimaryColumn, Unique } from "typeorm";
import type { RevisionSnapshot } from "@/lib/bookings/revision";
import { BookingEntity } from "./booking.entity";
import { BookingAdjustmentEntity } from "./booking-adjustment.entity";
import { UserEntity } from "./user.entity";
import { LocationEntity } from "./location.entity";
import { CourtEntity } from "./court.entity";
import { CoachProfileEntity } from "./coach-profile.entity";
import { CoachingProgramEntity } from "./coaching-program.entity";

@Entity({ schema: "public", name: "booking_revisions" })
@Check("booking_revisions_recovery_version", "recovery_version=1")
@Unique("booking_revisions_identity", ["bookingId", "id"])
@Unique("booking_revisions_number", ["bookingId", "revisionNumber"])
@Unique("booking_revisions_predecessor", ["bookingId", "previousRevisionId"])
@Unique("booking_revisions_operation", ["bookingId", "operationKey"])
@Index("booking_revisions_adjustment", ["adjustmentId"], { unique: true, where: "adjustment_id IS NOT NULL" })
@ForeignKey(() => BookingEntity, ["bookingId"], ["id"], { name: "booking_revisions_booking_fkey", onDelete: "RESTRICT" })
@ForeignKey(() => BookingRevisionEntity, ["bookingId", "previousRevisionId"], ["bookingId", "id"], { name: "booking_revisions_previous_fkey", onDelete: "RESTRICT" })
@ForeignKey(() => BookingAdjustmentEntity, ["bookingId", "adjustmentId"], ["bookingId", "id"], { name: "booking_revisions_adjustment_fkey", onDelete: "NO ACTION", deferrable: "INITIALLY DEFERRED" })
@ForeignKey(() => UserEntity, ["actorUserId"], ["id"], { name: "booking_revisions_actor_fkey", onDelete: "RESTRICT" })
@ForeignKey(() => LocationEntity, ["locationId"], ["id"], { name: "booking_revisions_location_fkey", onDelete: "RESTRICT" })
@ForeignKey(() => CourtEntity, ["courtId"], ["id"], { name: "booking_revisions_court_fkey", onDelete: "RESTRICT" })
@ForeignKey(() => CoachProfileEntity, ["coachUserId"], ["userId"], { name: "booking_revisions_coach_fkey", onDelete: "RESTRICT" })
@ForeignKey(() => CoachingProgramEntity, ["coachingProgramId"], ["id"], { name: "booking_revisions_coaching_program_fkey", onDelete: "RESTRICT" })
// A coaching contract names its coach and program with their historical names; a court booking names neither.
@Check("booking_revisions_coaching", "(coach_user_id IS NULL AND coaching_program_id IS NULL AND coach_name IS NULL AND coaching_program_name IS NULL) OR (coach_user_id IS NOT NULL AND coaching_program_id IS NOT NULL AND coach_name IS NOT NULL AND coaching_program_name IS NOT NULL AND char_length(btrim(coach_name)) BETWEEN 1 AND 100 AND char_length(btrim(coaching_program_name)) BETWEEN 1 AND 100)")
@Check("booking_revisions_first", "(revision_number=1 AND previous_revision_id IS NULL AND kind='created') OR (revision_number>1 AND previous_revision_id IS NOT NULL AND kind<>'created')")
@Check("booking_revisions_state", "(kind='created' AND booking_state IN ('pending_payment','confirmed')) OR (kind IN ('confirmed','rescheduled') AND booking_state='confirmed') OR (kind='cancelled' AND booking_state='cancelled')")
@Check("booking_revisions_scope", "actor_scope IN ('guest','customer','coach_owner','admin_owner','admin','provider')")
@Check("booking_revisions_cancellation", "(kind='cancelled' AND cancellation_cause IS NOT NULL AND cancellation_cause IN ('owner_cancelled','admin_cancelled','checkout_abandoned')) OR (kind<>'cancelled' AND cancellation_cause IS NULL)")
@Check("booking_revisions_amount", "total_amount_minor > 0")
@Check("booking_revisions_notice", "cancellation_notice_minutes BETWEEN 0 AND 43200")
@Check("booking_revisions_interval", "isfinite(booking_date) AND starts_at_minute>=0 AND ends_at_minute<=1440 AND starts_at_minute%30=0 AND ends_at_minute%30=0 AND ends_at_minute-starts_at_minute>=60")
@Check("booking_revisions_evidence", "jsonb_typeof(pricing_evidence)='object' AND octet_length(pricing_evidence::text)<=20000")
@Check("booking_revisions_currency", "currency IN ('EUR','USD','GBP','RON','CHF')")
@Check("booking_revisions_method", "payment_method IN ('online','pay_at_club')")
@Check("booking_revisions_contact", "char_length(btrim(customer_name)) BETWEEN 1 AND 200 AND char_length(btrim(customer_email)) BETWEEN 1 AND 320 AND char_length(btrim(customer_phone)) BETWEEN 1 AND 50")
@Check("booking_revisions_timestamp", "isfinite(recorded_at)")
@Check("booking_revisions_operation_key", "char_length(operation_key) BETWEEN 1 AND 128 AND char_length(intent_hash) BETWEEN 1 AND 64")
export class BookingRevisionEntity implements RevisionSnapshot {
  @Column({ name: "recovery_version", type: "smallint", nullable: true }) recoveryVersion?: number | null;
  @PrimaryColumn({ type: "uuid", primaryKeyConstraintName: "booking_revisions_pkey" }) id!: string;
  @Column({ name: "booking_id", type: "uuid" }) bookingId!: string;
  @Column({ name: "revision_number", type: "integer" }) revisionNumber!: number;
  @Column({ name: "previous_revision_id", type: "uuid", nullable: true }) previousRevisionId!: string | null;
  @Column({ name: "operation_key", type: "text" }) operationKey!: string;
  @Column({ name: "intent_hash", type: "text" }) intentHash!: string;
  @Column({ type: "text" }) kind!: RevisionSnapshot["kind"];
  @Column({ name: "booking_state", type: "text" }) bookingState!: RevisionSnapshot["bookingState"];
  @Column({ name: "location_id", type: "uuid" }) locationId!: string;
  @Column({ name: "court_id", type: "uuid" }) courtId!: string;
  @Column({ name: "location_name", type: "text" }) locationName!: string;
  @Column({ name: "court_name", type: "text" }) courtName!: string;
  @Column({ type: "text" }) timezone!: string;
  @Column({ name: "booking_date", type: "date" }) bookingDate!: string;
  @Column({ name: "starts_at_minute", type: "integer" }) startMinute!: number;
  @Column({ name: "ends_at_minute", type: "integer" }) endMinute!: number;
  @Column({ name: "customer_name", type: "text" }) customerName!: string;
  @Column({ name: "customer_email", type: "text" }) customerEmail!: string;
  @Column({ name: "customer_phone", type: "text" }) customerPhone!: string;
  @Column({ name: "total_amount_minor", type: "integer" }) totalAmountMinor!: number;
  @Column({ type: "text" }) currency!: RevisionSnapshot["currency"];
  @Column({ name: "payment_method", type: "text" }) paymentMethod!: RevisionSnapshot["paymentMethod"];
  @Column({ name: "cancellation_notice_minutes", type: "integer" }) cancellationNoticeMinutes!: number;
  @Column({ name: "actor_user_id", type: "uuid", nullable: true }) actorUserId!: string | null;
  @Column({ name: "actor_scope", type: "text" }) actorScope!: RevisionSnapshot["actorScope"];
  @Column({ name: "recorded_at", type: "timestamptz" }) recordedAt!: Date;
  @Column({ name: "adjustment_id", type: "uuid", nullable: true }) adjustmentId!: string | null;
  @Column({ name: "cancellation_cause", type: "text", nullable: true }) cancellationCause!: RevisionSnapshot["cancellationCause"];
  @Column({ name: "pricing_evidence", type: "jsonb" }) pricingEvidence!: RevisionSnapshot["pricingEvidence"];
  @Column({ name: "coach_user_id", type: "uuid", nullable: true }) coachUserId?: string | null;
  @Column({ name: "coaching_program_id", type: "uuid", nullable: true }) coachingProgramId?: string | null;
  @Column({ name: "coach_name", type: "text", nullable: true }) coachName?: string | null;
  @Column({ name: "coaching_program_name", type: "text", nullable: true }) coachingProgramName?: string | null;
}
