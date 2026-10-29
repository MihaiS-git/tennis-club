import type { MigrationInterface, QueryRunner } from "typeorm";

export class SeparateCheckoutBookings1791462257927 implements MigrationInterface {
  name = "SeparateCheckoutBookings1791462257927";

  async up(queryRunner: QueryRunner): Promise<void> {
    // Preserve every financial FK, immutable revision and historical identifier.
    // The old aggregate is a checkout record, whether or not it ever confirmed.
    await queryRunner.query(`ALTER TABLE public.bookings RENAME TO checkout_records`);
    for (const name of ["validate_booking_revision_append", "validate_booking_revision_head"]) {
      const [row]: { definition: string }[] = await queryRunner.query(
        `SELECT pg_get_functiondef($1::regprocedure) AS definition`, [`public.${name}()`]);
      await queryRunner.query(row.definition.replaceAll("public.bookings", "public.checkout_records")
        .replaceAll("TG_TABLE_NAME='bookings'", "TG_TABLE_NAME='checkout_records'"));
    }
    await queryRunner.query(`CREATE TABLE public.bookings (
      id uuid CONSTRAINT confirmed_bookings_pkey PRIMARY KEY,
      confirmation_revision_id uuid NOT NULL,
      CONSTRAINT confirmed_booking_checkout_fkey FOREIGN KEY(id) REFERENCES public.checkout_records(id) ON DELETE RESTRICT,
      CONSTRAINT confirmed_booking_revision_fkey FOREIGN KEY(id,confirmation_revision_id)
        REFERENCES public.booking_revisions(booking_id,id) ON DELETE RESTRICT
    )`);
    // A cancelled checkout alone is never confirmation evidence. Retain actual
    // historical bookings, including those subsequently cancelled.
    await queryRunner.query(`INSERT INTO public.bookings(id,confirmation_revision_id)
      SELECT DISTINCT ON (booking_id) booking_id,id FROM public.booking_revisions
      WHERE booking_state='confirmed' AND kind IN ('created','confirmed')
      ORDER BY booking_id,revision_number`);
    await queryRunner.query(`REVOKE ALL ON public.bookings FROM PUBLIC,anon,authenticated`);
    await queryRunner.query(`GRANT ALL ON public.bookings TO service_role`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE public.bookings`);
    await queryRunner.query(`ALTER TABLE public.checkout_records RENAME TO bookings`);
    for (const name of ["validate_booking_revision_append", "validate_booking_revision_head"]) {
      const [row]: { definition: string }[] = await queryRunner.query(
        `SELECT pg_get_functiondef($1::regprocedure) AS definition`, [`public.${name}()`]);
      await queryRunner.query(row.definition.replaceAll("public.checkout_records", "public.bookings")
        .replaceAll("TG_TABLE_NAME='checkout_records'", "TG_TABLE_NAME='bookings'"));
    }
  }
}
