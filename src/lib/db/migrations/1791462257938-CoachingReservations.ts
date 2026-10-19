import type { MigrationInterface, QueryRunner } from "typeorm";

export class CoachingReservations1791462257938 implements MigrationInterface {
  name = "CoachingReservations1791462257938";
  async up(queryRunner: QueryRunner): Promise<void> {
    // A coaching lesson reuses the booking, its revisions and its one court reservation.
    // The occupancy row also names the coach, so holds, expiry, settlement and release
    // cover coach and court together. Generated from the entity metadata; eligibility,
    // availability and pricing stay in TypeScript. Existing rows remain court bookings.
    await queryRunner.query(`ALTER TABLE "public"."court_reservations" ADD "coach_user_id" uuid`);
    await queryRunner.query(`ALTER TABLE "public"."booking_revisions" ADD "coach_user_id" uuid`);
    await queryRunner.query(`ALTER TABLE "public"."booking_revisions" ADD "coaching_program_id" uuid`);
    await queryRunner.query(`ALTER TABLE "public"."booking_revisions" ADD "coach_name" text`);
    await queryRunner.query(`ALTER TABLE "public"."booking_revisions" ADD "coaching_program_name" text`);
    await queryRunner.query(`ALTER TABLE "public"."booking_revisions" ADD CONSTRAINT "booking_revisions_coaching" CHECK ((coach_user_id IS NULL AND coaching_program_id IS NULL AND coach_name IS NULL AND coaching_program_name IS NULL) OR (coach_user_id IS NOT NULL AND coaching_program_id IS NOT NULL AND coach_name IS NOT NULL AND coaching_program_name IS NOT NULL AND char_length(btrim(coach_name)) BETWEEN 1 AND 100 AND char_length(btrim(coaching_program_name)) BETWEEN 1 AND 100))`);
    await queryRunner.query(`ALTER TABLE "public"."court_reservations" ADD CONSTRAINT "court_reservation_coach_no_overlap" EXCLUDE USING gist (coach_user_id WITH =, booking_date WITH =, int4range(starts_at_minute, ends_at_minute, '[)') WITH &&) WHERE (coach_user_id IS NOT NULL AND status IN ('active', 'held'))`);
    await queryRunner.query(`ALTER TABLE "public"."court_reservations" ADD CONSTRAINT "court_reservations_coach_user_id_fkey" FOREIGN KEY ("coach_user_id") REFERENCES "public"."coach_profiles"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "public"."booking_revisions" ADD CONSTRAINT "booking_revisions_coaching_program_fkey" FOREIGN KEY ("coaching_program_id") REFERENCES "public"."coaching_programs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "public"."booking_revisions" ADD CONSTRAINT "booking_revisions_coach_fkey" FOREIGN KEY ("coach_user_id") REFERENCES "public"."coach_profiles"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    // Never discard coaching contracts or occupancy by rolling back.
    await queryRunner.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.court_reservations WHERE coach_user_id IS NOT NULL)
      OR EXISTS (SELECT 1 FROM public.booking_revisions WHERE coach_user_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Coaching reservations exist; refusing to drop them'; END IF; END $$`);
    await queryRunner.query(`ALTER TABLE "public"."booking_revisions" DROP CONSTRAINT "booking_revisions_coach_fkey"`);
    await queryRunner.query(`ALTER TABLE "public"."booking_revisions" DROP CONSTRAINT "booking_revisions_coaching_program_fkey"`);
    await queryRunner.query(`ALTER TABLE "public"."court_reservations" DROP CONSTRAINT "court_reservations_coach_user_id_fkey"`);
    await queryRunner.query(`ALTER TABLE "public"."court_reservations" DROP CONSTRAINT "court_reservation_coach_no_overlap"`);
    await queryRunner.query(`ALTER TABLE "public"."booking_revisions" DROP CONSTRAINT "booking_revisions_coaching"`);
    await queryRunner.query(`ALTER TABLE "public"."booking_revisions" DROP COLUMN "coaching_program_name"`);
    await queryRunner.query(`ALTER TABLE "public"."booking_revisions" DROP COLUMN "coach_name"`);
    await queryRunner.query(`ALTER TABLE "public"."booking_revisions" DROP COLUMN "coaching_program_id"`);
    await queryRunner.query(`ALTER TABLE "public"."booking_revisions" DROP COLUMN "coach_user_id"`);
    await queryRunner.query(`ALTER TABLE "public"."court_reservations" DROP COLUMN "coach_user_id"`);
  }
}
