import type { MigrationInterface, QueryRunner } from "typeorm";

export class FairNotificationRecovery1791462257936 implements MigrationInterface {
  name = "FairNotificationRecovery1791462257936";
  async up(runner: QueryRunner): Promise<void> {
    // A scan position only: no financial state, messages or event backfill.
    await runner.query(`CREATE TABLE public.notification_recovery_cursor (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      occurred_at timestamptz, event_key text,
      CHECK ((occurred_at IS NULL) = (event_key IS NULL)),
      CHECK (occurred_at IS NULL OR isfinite(occurred_at)))`);
    await runner.query(`INSERT INTO public.notification_recovery_cursor(singleton) VALUES(true)`);
    await runner.query(`REVOKE ALL ON public.notification_recovery_cursor FROM PUBLIC,anon,authenticated,service_role`);
  }
  async down(runner: QueryRunner): Promise<void> {
    // Losing traversal position only restarts the scan; evidence stays intact.
    await runner.query(`DROP TABLE public.notification_recovery_cursor`);
  }
}
