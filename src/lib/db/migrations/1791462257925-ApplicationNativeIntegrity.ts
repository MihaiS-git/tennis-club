import type { MigrationInterface, QueryRunner } from "typeorm";

// PostgreSQL expression indexes, external Auth FK, overlap constraints and bootstrap
// records complement the entity-generated schema. No application policy triggers.
export class ApplicationNativeIntegrity1791462257925 implements MigrationInterface {
  name = "ApplicationNativeIntegrity1791462257925";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions`);
    await queryRunner.query(`SET LOCAL search_path = public, extensions`);
    await queryRunner.query(`CREATE UNIQUE INDEX users_email_lower_unique ON public.users (lower(email))`);
    await queryRunner.query(`ALTER TABLE public.users ADD CONSTRAINT users_id_fkey
      FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE RESTRICT`);
    await queryRunner.query(`ALTER TABLE public.court_coverage_periods ADD CONSTRAINT court_coverage_no_overlap
      EXCLUDE USING gist (court_id WITH =, daterange(starts_on, ends_on, '[]') WITH &&)`);
    await queryRunner.query(`ALTER TABLE public.location_opening_hours ADD CONSTRAINT location_opening_hours_no_overlap
      EXCLUDE USING gist (location_id WITH =, weekday WITH =, int4range(opens_at_minute, closes_at_minute, '[)') WITH &&)`);
    await queryRunner.query(`ALTER TABLE public.location_pricing_rules ADD CONSTRAINT location_pricing_no_overlap
      EXCLUDE USING gist (court_id WITH =, court_state WITH =, weekday WITH =,
        daterange(starts_on, ends_on, '[]') WITH &&, int4range(starts_at_minute, ends_at_minute, '[)') WITH &&)`);
    await queryRunner.query(`ALTER TABLE public.court_reservations ADD CONSTRAINT court_reservation_no_overlap
      EXCLUDE USING gist (court_id WITH =, booking_date WITH =, int4range(starts_at_minute, ends_at_minute, '[)') WITH &&)
      WHERE (status IN ('active', 'held'))`);
    await queryRunner.query(`INSERT INTO public.roles(code) VALUES ('admin'), ('coach')`);
    await queryRunner.query(`INSERT INTO public.payment_provider_settings(id) VALUES (true)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM public.payment_provider_settings WHERE id = true`);
    await queryRunner.query(`DELETE FROM public.roles WHERE code IN ('admin', 'coach')`);
    await queryRunner.query(`ALTER TABLE public.court_reservations DROP CONSTRAINT court_reservation_no_overlap`);
    await queryRunner.query(`ALTER TABLE public.location_pricing_rules DROP CONSTRAINT location_pricing_no_overlap`);
    await queryRunner.query(`ALTER TABLE public.location_opening_hours DROP CONSTRAINT location_opening_hours_no_overlap`);
    await queryRunner.query(`ALTER TABLE public.court_coverage_periods DROP CONSTRAINT court_coverage_no_overlap`);
    await queryRunner.query(`ALTER TABLE public.users DROP CONSTRAINT users_id_fkey`);
    await queryRunner.query(`DROP INDEX public.users_email_lower_unique`);
    // btree_gist may be shared with Supabase infrastructure; retain the extension.
  }
}
