import type { MigrationInterface, QueryRunner } from "typeorm";

export class CoachRosterRemoval1791462257939 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE public.coach_profiles ADD COLUMN archived_at timestamptz`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE public.coach_profiles DROP COLUMN archived_at`);
  }
}
