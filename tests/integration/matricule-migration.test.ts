import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { findMatriculeCollisions } from '../../src/shared/database/matricule-collisions.js';

describe('normalized matricule migration', () => {
  it('reports existing collisions without overwriting, then enforces uniqueness per population', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL_TEST });
    const schema = `school_c20_${Math.random().toString(36).slice(2, 10)}`;
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      for (const population of ['students', 'teachers']) {
        await pool.query(`CREATE TABLE "${schema}"."${population}" (id uuid PRIMARY KEY, matricule varchar(50))`);
      }
      await pool.query(`INSERT INTO "${schema}".students VALUES ('00000000-0000-4000-8000-000000000001', 'E-001'), ('00000000-0000-4000-8000-000000000002', ' e-001 ')`);
      await pool.query(`INSERT INTO "${schema}".teachers VALUES ('00000000-0000-4000-8000-000000000003', 'E-001')`);
      expect(await findMatriculeCollisions(pool, schema)).toEqual([{ population: 'students', ids: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'] }]);
      const source = (await readFile('src/shared/database/migrations/0079_matricule_normalized_unique.sql', 'utf8')).replaceAll('"tenant"', `"${schema}"`);
      await expect(pool.query(source.split('--> statement-breakpoint')[0]!)).rejects.toMatchObject({ code: '23505' });
      expect((await pool.query(`SELECT count(*)::int AS count FROM "${schema}".students`)).rows[0].count).toBe(2);

      await pool.query(`UPDATE "${schema}".students SET matricule = 'E-002' WHERE id = '00000000-0000-4000-8000-000000000002'`);
      for (const statement of source.split('--> statement-breakpoint')) await pool.query(statement);
      for (const population of ['students', 'teachers']) {
        await expect(pool.query(`INSERT INTO "${schema}"."${population}" VALUES (gen_random_uuid(), ' e-001 ')`)).rejects.toMatchObject({ code: '23505' });
        await pool.query(`INSERT INTO "${schema}"."${population}" VALUES (gen_random_uuid(), NULL), (gen_random_uuid(), NULL)`);
      }
      expect(await findMatriculeCollisions(pool, schema)).toEqual([]);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
});
