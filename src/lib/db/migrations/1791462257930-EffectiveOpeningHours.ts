import type { MigrationInterface, QueryRunner } from "typeorm";

export class EffectiveOpeningHours1791462257930 implements MigrationInterface {
  name = "EffectiveOpeningHours1791462257930";
  async up(runner: QueryRunner): Promise<void> {
    await runner.query("SET LOCAL search_path = public, extensions");
    await runner.query(`CREATE TABLE public.opening_hours_schedules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
      starts_on date NOT NULL, ends_on date, revision integer NOT NULL DEFAULT 1,
      CONSTRAINT opening_hours_schedules_dates CHECK (ends_on IS NULL OR starts_on <= ends_on),
      CONSTRAINT opening_hours_schedules_location_identity UNIQUE (location_id, id),
      CONSTRAINT opening_hours_schedules_no_overlap EXCLUDE USING gist
        (location_id WITH =, daterange(starts_on, ends_on, '[]') WITH &&))`);
    // An unexpired baseline preserves the entire previous recurring calendar,
    // including historical dates. No reservation or financial row is touched.
    await runner.query(`INSERT INTO public.opening_hours_schedules(location_id, starts_on)
      SELECT id, DATE '0001-01-01' FROM public.locations`);
    await runner.query("ALTER TABLE public.location_opening_hours ADD COLUMN schedule_id uuid");
    await runner.query(`UPDATE public.location_opening_hours h SET schedule_id=s.id
      FROM public.opening_hours_schedules s WHERE s.location_id=h.location_id`);
    await runner.query(`ALTER TABLE public.location_opening_hours
      ALTER COLUMN schedule_id SET NOT NULL,
      ADD CONSTRAINT location_opening_hours_schedule_fkey FOREIGN KEY (location_id, schedule_id)
        REFERENCES public.opening_hours_schedules(location_id, id) ON DELETE CASCADE,
      DROP CONSTRAINT location_opening_hours_no_overlap,
      ADD CONSTRAINT location_opening_hours_no_overlap EXCLUDE USING gist
        (schedule_id WITH =, weekday WITH =, int4range(opens_at_minute, closes_at_minute, '[)') WITH &&)`);
    await runner.query("REVOKE ALL ON public.opening_hours_schedules FROM anon, authenticated");
  }
  async down(runner: QueryRunner): Promise<void> {
    // Legacy weekly hours can represent only one unrestricted baseline per location.
    const incompatible: unknown[] = await runner.query(`SELECT location_id FROM public.opening_hours_schedules
      GROUP BY location_id HAVING count(*) > 1
        OR bool_or(starts_on <> DATE '0001-01-01' OR ends_on IS NOT NULL)`);
    if (incompatible.length) throw new Error("Cannot faithfully restore legacy opening hours from dated schedules.");
    await runner.query("SET LOCAL search_path = public, extensions");
    await runner.query(`ALTER TABLE public.location_opening_hours
      DROP CONSTRAINT location_opening_hours_no_overlap,
      DROP COLUMN schedule_id,
      ADD CONSTRAINT location_opening_hours_no_overlap EXCLUDE USING gist
        (location_id WITH =, weekday WITH =, int4range(opens_at_minute, closes_at_minute, '[)') WITH &&)`);
    await runner.query("DROP TABLE public.opening_hours_schedules");
  }
}
