import type { MigrationInterface, QueryRunner } from "typeorm";

export class CanonicalCoachingDurations1791462257928 implements MigrationInterface {
  name = "CanonicalCoachingDurations1791462257928";
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE public.coaching_program_durations
      DROP CONSTRAINT coaching_program_durations_minutes_check,
      ADD CONSTRAINT coaching_program_durations_minutes_check
      CHECK (duration_minutes IN (60, 90, 120)) NOT VALID`);
    // Do not delete legacy configuration or rewrite purchased lesson contracts.
    // New/updated rows are checked immediately; validate existing rows when compatible.
    const [legacy] = await runner.query(`SELECT EXISTS (SELECT 1 FROM public.coaching_program_durations
      WHERE duration_minutes NOT IN (60, 90, 120)) AS present`);
    if (!legacy.present) await runner.query(`ALTER TABLE public.coaching_program_durations
      VALIDATE CONSTRAINT coaching_program_durations_minutes_check`);
  }
  async down(): Promise<void> {
    throw new Error("Restoring unsupported coaching durations requires a reviewed migration.");
  }
}
