import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';

describe('notification channel migration replay', () => {
  it('keeps existing in_app notifications valid when migration 0023 is replayed', async () => {
    const schema = `school_demo_channel_${randomBytes(4).toString('hex')}`;
    const pool = new Pool({ connectionString: process.env.DATABASE_URL_TEST, max: 1 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`CREATE TABLE "${schema}"."notifications_log" (
        channel varchar(10) NOT NULL DEFAULT 'sms',
        CONSTRAINT notifications_log_channel_check CHECK (channel IN ('sms', 'email', 'in_app'))
      )`);
      await client.query(`INSERT INTO "${schema}"."notifications_log" (channel) VALUES ('in_app')`);

      const source = await readFile(
        new URL('../../src/shared/database/migrations/0023_notifications_email_channel.sql', import.meta.url),
        'utf8'
      );
      for (const statement of source.replaceAll('"tenant"', `"${schema}"`).split('--> statement-breakpoint')) {
        if (statement.trim()) await client.query(statement);
      }

      const rows = await client.query<{ channel: string }>(
        `SELECT channel FROM "${schema}"."notifications_log"`
      );
      expect(rows.rows).toEqual([{ channel: 'in_app' }]);
      await expect(client.query(
        `INSERT INTO "${schema}"."notifications_log" (channel) VALUES ('invalid')`
      )).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await pool.end();
    }
  });
});
