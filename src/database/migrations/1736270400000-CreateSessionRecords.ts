import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSessionRecords1736270400000 implements MigrationInterface {
  name = 'CreateSessionRecords1736270400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`
      CREATE TABLE "session_records" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "goal" text NOT NULL,
        "taskType" character varying(64),
        "status" character varying(32) NOT NULL DEFAULT 'running',
        "startedAt" TIMESTAMPTZ NOT NULL,
        "endedAt" TIMESTAMPTZ,
        "steps" jsonb NOT NULL DEFAULT '[]',
        "result" jsonb,
        "error" text,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_session_records_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_session_records_taskType" ON "session_records" ("taskType")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_session_records_status" ON "session_records" ("status")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_session_records_status"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_session_records_taskType"`);
    await queryRunner.query(`DROP TABLE "session_records"`);
  }
}
