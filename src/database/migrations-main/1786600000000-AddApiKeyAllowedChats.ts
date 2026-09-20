import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `allowedChats` to `api_keys` — the chat-level allowlist that scopes a key to chosen chats
 * (a curated set of groups, and/or individual contacts) next to the existing session scope.
 *
 * NULL/empty means "every chat", the same fail-open semantic as `allowedSessions`, and the two are
 * independent: a key may carry either list, both, or neither. The column is `simple-array` on the
 * entity, so it is stored as a comma-joined `text` column here, exactly like `allowedSessions`.
 *
 * Runs on the **main** connection (auth), which is always SQLite. Idempotent: the column is probed
 * before the ALTER, so a run interrupted after the DDL still completes and a database previously
 * created by `synchronize` is safe to adopt.
 */
export class AddApiKeyAllowedChats1786600000000 implements MigrationInterface {
  name = 'AddApiKeyAllowedChats1786600000000';

  private async hasColumn(queryRunner: QueryRunner, name: string): Promise<boolean> {
    if (queryRunner.connection.options.type === 'postgres') {
      const rows = (await queryRunner.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'api_keys' AND column_name = '${name}'`,
      )) as unknown[];
      return rows.length > 0;
    }
    const rows = (await queryRunner.query(`PRAGMA table_info("api_keys")`)) as Array<{ name: string }>;
    return rows.some(r => r.name === name);
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.hasColumn(queryRunner, 'allowedChats'))) {
      await queryRunner.query(`ALTER TABLE "api_keys" ADD COLUMN "allowedChats" text NULL`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await this.hasColumn(queryRunner, 'allowedChats')) {
      await queryRunner.query(`ALTER TABLE "api_keys" DROP COLUMN "allowedChats"`);
    }
  }
}
