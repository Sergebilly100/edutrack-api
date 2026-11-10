import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { EnrollmentsRepository } from '../../src/modules/enrollments/enrollments.repository.js';

const dialect = new PgDialect();

describe('liste des dossiers d’inscription : tri par défaut', () => {
  it('date d’inscription décroissante, départage stable par date de création puis identifiant', async () => {
    const statements: string[] = [];
    const db = { execute: async (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
      statements.push(dialect.sqlToQuery(query).sql.replace(/\s+/g, ' ').trim());
      return { rows: [] };
    } };
    await new EnrollmentsRepository(db as never).listEnrollments({ page: 2, limit: 20 });
    const listSql = statements.find((text) => text.includes('ORDER BY'))!;
    expect(listSql).toContain('ORDER BY e.enrolled_at DESC, e.created_at DESC, e.id DESC');
    expect(listSql).toContain('LIMIT');
  });
});
