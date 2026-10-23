import type { MigrationInterface, QueryRunner } from "typeorm";

export class ClubSettings1791462257927 implements MigrationInterface {
  name = "ClubSettings1791462257927";
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE public.club_settings (
      id boolean PRIMARY KEY DEFAULT true CONSTRAINT club_settings_singleton CHECK (id),
      official_email text NOT NULL DEFAULT '', sender_name text NOT NULL DEFAULT '',
      emails_enabled boolean NOT NULL DEFAULT false,
      CONSTRAINT club_settings_sender CHECK (NOT emails_enabled OR
        (length(trim(official_email)) > 0 AND length(trim(sender_name)) > 0))
    )`);
    await runner.query(`INSERT INTO public.club_settings (id) VALUES (true)`);
    await runner.query(`REVOKE ALL ON public.club_settings FROM PUBLIC, anon, authenticated`);
    await runner.query(`ALTER TABLE public.email_deliveries ADD COLUMN suppressed_at timestamptz`);
    // Delivery starts disabled. Existing unsent mail must not reappear on activation.
    await runner.query(`UPDATE public.email_deliveries SET suppressed_at=clock_timestamp()
      WHERE status IN ('pending','processing','failed')`);
  }
  async down(): Promise<void> {
    throw new Error("Club settings rollback requires a reviewed migration preserving suppression evidence.");
  }
}
