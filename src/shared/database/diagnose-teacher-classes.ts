/** Read-only UUID audit of the recorded relations behind a teacher's class list. */
import 'dotenv/config';
import { Pool } from 'pg';

const schema = process.argv.find((arg) => arg.startsWith('--schema='))?.slice('--schema='.length);
const userId = process.argv.find((arg) => arg.startsWith('--teacher-user-id='))?.slice('--teacher-user-id='.length);
if (!schema || !/^school_[a-z0-9_]+$/.test(schema) || schema.length > 63) throw new Error('INVALID_TENANT_SCHEMA');
if (userId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
  throw new Error('INVALID_TEACHER_USER_ID');
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const registered = await client.query('SELECT 1 FROM public.tenants WHERE schema_name = $1 LIMIT 1', [schema]);
    if (!registered.rows.length) throw new Error('TENANT_NOT_REGISTERED');
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    const result = await client.query<{
      teacher_id: string; user_id: string; class_id: string | null;
      assignment_ids: string[]; subject_ids: string[]; schedule_ids: string[];
    }>(`
      SELECT t.id::text AS teacher_id, t.user_id::text AS user_id, c.id::text AS class_id,
        COALESCE(array_agg(DISTINCT tsa.id::text) FILTER (WHERE tsa.id IS NOT NULL), ARRAY[]::text[]) AS assignment_ids,
        COALESCE(array_agg(DISTINCT tsa.subject_id::text) FILTER (WHERE tsa.id IS NOT NULL), ARRAY[]::text[]) AS subject_ids,
        COALESCE(array_agg(DISTINCT sch.id::text) FILTER (WHERE sch.id IS NOT NULL), ARRAY[]::text[]) AS schedule_ids
      FROM teachers t
      LEFT JOIN classes c ON c.is_active = true AND (
        EXISTS (SELECT 1 FROM teacher_subject_assignments a WHERE a.teacher_id = t.id AND a.class_id = c.id)
        OR EXISTS (SELECT 1 FROM schedules s WHERE s.teacher_id = t.id AND s.class_id = c.id AND s.is_active = true)
      )
      LEFT JOIN teacher_subject_assignments tsa ON tsa.teacher_id = t.id AND tsa.class_id = c.id
      LEFT JOIN schedules sch ON sch.teacher_id = t.id AND sch.class_id = c.id AND sch.is_active = true
      WHERE ($1::uuid IS NULL OR t.user_id = $1::uuid)
      GROUP BY t.id, t.user_id, c.id ORDER BY t.id, c.id
    `, [userId ?? null]);
    for (const row of result.rows) {
      console.log(JSON.stringify({ schema, ...row,
        source: row.assignment_ids.length && row.schedule_ids.length ? 'both'
          : row.assignment_ids.length ? 'assignment' : row.schedule_ids.length ? 'active_schedule' : 'none' }));
    }
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
