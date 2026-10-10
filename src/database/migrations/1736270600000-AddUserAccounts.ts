import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUserAccounts1736270600000 implements MigrationInterface {
  name = 'AddUserAccounts1736270600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Rows from before accounts keep '' and match no user, so they stay hidden.
    await queryRunner.query(`
      ALTER TABLE "session_records"
      ADD COLUMN IF NOT EXISTS "userId" varchar(128) NOT NULL DEFAULT ''
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_session_records_userId"
      ON "session_records" ("userId")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "user_app_connections" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" varchar(128) NOT NULL,
        "toolkit" varchar(64) NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'pending',
        "composioAccountId" varchar(128),
        "metadata" jsonb NOT NULL DEFAULT '{}',
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_app_connections" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_user_app_connections_user_toolkit"
      ON "user_app_connections" ("userId", "toolkit")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "user_browser_profiles" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" varchar(128) NOT NULL,
        "site" varchar(255) NOT NULL,
        "profileId" varchar(128) NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'uploading',
        "lastUsedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_browser_profiles" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_user_browser_profiles_user_site"
      ON "user_browser_profiles" ("userId", "site")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "user_browser_profiles"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "user_app_connections"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_session_records_userId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "session_records" DROP COLUMN IF EXISTS "userId"`,
    );
  }
}
