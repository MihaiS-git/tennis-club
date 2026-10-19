import type { MigrationInterface, QueryRunner } from "typeorm";

const tables = ["coach_availability_exceptions", "coach_weekly_availability"];

export class CoachAvailability1791462257937 implements MigrationInterface {
  name = "CoachAvailability1791462257937";
  async up(queryRunner: QueryRunner): Promise<void> {
    // Coach weekly working intervals and date exceptions, in each location's local
    // wall time. Generated from the entity metadata; schedule resolution and
    // eligibility stay in TypeScript. Availability alone never makes a lesson bookable.
    await queryRunner.query(`CREATE TABLE "public"."coach_availability_exceptions" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "coach_user_id" uuid NOT NULL, "exception_date" date NOT NULL, "kind" text NOT NULL, "location_id" uuid, "start_minute" integer, "end_minute" integer, "note" text NOT NULL DEFAULT '', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "coach_availability_exceptions_note_check" CHECK (char_length(note) <= 200), CONSTRAINT "coach_availability_exceptions_minutes_check" CHECK ((start_minute IS NULL AND end_minute IS NULL) OR (start_minute IS NOT NULL AND end_minute IS NOT NULL AND start_minute >= 0 AND end_minute <= 1440 AND start_minute < end_minute AND start_minute % 30 = 0 AND end_minute % 30 = 0)), CONSTRAINT "coach_availability_exceptions_kind_check" CHECK ((kind = 'unavailable' AND location_id IS NULL) OR (kind = 'available' AND location_id IS NOT NULL AND start_minute IS NOT NULL)), CONSTRAINT "coach_availability_exceptions_no_overlap" EXCLUDE USING gist (coach_user_id WITH =, exception_date WITH =, int4range(COALESCE(start_minute, 0), COALESCE(end_minute, 1440), '[)') WITH &&), CONSTRAINT "coach_availability_exceptions_pkey" PRIMARY KEY ("id"))`);
    await queryRunner.query(`CREATE TABLE "public"."coach_weekly_availability" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "coach_user_id" uuid NOT NULL, "location_id" uuid NOT NULL, "weekday" integer NOT NULL, "start_minute" integer NOT NULL, "end_minute" integer NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "coach_weekly_availability_minutes_check" CHECK (start_minute >= 0 AND end_minute <= 1440 AND start_minute < end_minute AND start_minute % 30 = 0 AND end_minute % 30 = 0), CONSTRAINT "coach_weekly_availability_weekday_check" CHECK (weekday BETWEEN 0 AND 6), CONSTRAINT "coach_weekly_availability_no_overlap" EXCLUDE USING gist (coach_user_id WITH =, weekday WITH =, int4range(start_minute, end_minute, '[)') WITH &&), CONSTRAINT "coach_weekly_availability_pkey" PRIMARY KEY ("id"))`);
    await queryRunner.query(`ALTER TABLE "public"."coach_availability_exceptions" ADD CONSTRAINT "coach_availability_exceptions_coach_location_fkey" FOREIGN KEY ("coach_user_id", "location_id") REFERENCES "public"."coach_locations"("coach_user_id","location_id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "public"."coach_availability_exceptions" ADD CONSTRAINT "coach_availability_exceptions_coach_user_id_fkey" FOREIGN KEY ("coach_user_id") REFERENCES "public"."coach_profiles"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "public"."coach_weekly_availability" ADD CONSTRAINT "coach_weekly_availability_coach_location_fkey" FOREIGN KEY ("coach_user_id", "location_id") REFERENCES "public"."coach_locations"("coach_user_id","location_id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    // Default privileges already deny browser roles; keep the explicit guarantee.
    for (const table of tables) await queryRunner.query(`REVOKE ALL ON public.${table} FROM PUBLIC, anon, authenticated`);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of tables) await queryRunner.query(`DROP TABLE public.${table}`);
  }
}
