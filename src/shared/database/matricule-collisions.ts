import type { PoolClient } from 'pg';

export type MatriculeCollision = { population: 'students' | 'teachers'; ids: string[] };

/** UUID-only report: existing profiles are never merged or overwritten. */
export const findMatriculeCollisions = async (client: Pick<PoolClient, 'query'>, schemaName: string): Promise<MatriculeCollision[]> => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schemaName)) throw new Error('Invalid tenant schema name');
  const collisions: MatriculeCollision[] = [];
  for (const population of ['students', 'teachers'] as const) {
    const result = await client.query<{ ids: string[] }>(
      `SELECT array_agg(id::text ORDER BY id::text) AS ids FROM "${schemaName}"."${population}" WHERE matricule IS NOT NULL GROUP BY lower(btrim(matricule)) HAVING COUNT(*) > 1`
    );
    for (const row of result.rows) collisions.push({ population, ids: row.ids });
  }
  return collisions;
};
