import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSessionScreenshots1736270500000 implements MigrationInterface {
  name = 'AddSessionScreenshots1736270500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "session_records"
      ADD COLUMN IF NOT EXISTS "screenshots" jsonb NOT NULL DEFAULT '[]'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "session_records" DROP COLUMN IF EXISTS "screenshots"
    `);
  }
}
