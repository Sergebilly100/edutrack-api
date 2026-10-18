import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import { EnrollmentsRepository } from '../../src/modules/enrollments/enrollments.repository.js';

describe('recherche des dossiers annuels', () => {
  it('calcule le rang général depuis les moyennes actuelles de la classe', async () => {
    const dialect = new PgDialect();
    const executed: Array<{ sql: string; params: unknown[] }> = [];
    const execute = vi.fn(async (query: Parameters<PgDialect['sqlToQuery']>[0]) => {
      executed.push(dialect.sqlToQuery(query));
      return { rows: [] };
    });
    const repository = new EnrollmentsRepository({ execute } as never);

    await repository.listStudentYearResults(
      '11f746a0-1222-4444-8888-8a0aba160c29',
      '22f746a0-1222-4444-8888-8a0aba160c29'
    );

    const averageQuery = executed.find((query) => query.sql.includes('student_period_averages spa'));
    expect(averageQuery?.sql).toContain('COUNT(DISTINCT ROUND(peer_average.average, 2))');
    expect(averageQuery?.sql).toContain('current_average.average');
    expect(averageQuery?.sql).toContain("peer_enrollment.status = 'confirmed'");
    expect(averageQuery?.sql).toContain('student_enrollment.class_id');
  });

  it('applique le nom ou matricule à la page et au total avec les autres filtres', async () => {
    const dialect = new PgDialect();
    const executed: Array<{ sql: string; params: unknown[] }> = [];
    const execute = vi.fn(async (query: Parameters<PgDialect['sqlToQuery']>[0]) => {
      executed.push(dialect.sqlToQuery(query));
      return { rows: [] };
    });
    const repository = new EnrollmentsRepository({ execute } as never);

    await repository.listEnrollments({
      schoolYearId: '11f746a0-1222-4444-8888-8a0aba160c29',
      status: 'confirmed',
      search: 'Koné Aya',
      page: 1,
      limit: 20,
    });

    expect(executed).toHaveLength(2);
    for (const query of executed) {
      expect(query.params).toContain('%Koné Aya%');
      expect(query.sql).toContain('e.school_year_id');
      expect(query.sql).toContain('e.status');
      expect(query.sql).toContain('s.matricule ILIKE');
      expect(query.sql).toContain("concat_ws(' ', s.last_name, s.first_name) ILIKE");
    }
  });

  it('liste les candidats de l’année d’origine active sans année cible', async () => {
    const dialect = new PgDialect();
    const executed: Array<{ sql: string; params: unknown[] }> = [];
    const execute = vi.fn(async (query: Parameters<PgDialect['sqlToQuery']>[0]) => {
      executed.push(dialect.sqlToQuery(query));
      return { rows: [] };
    });
    const repository = new EnrollmentsRepository({ execute } as never);
    await repository.listReEnrollmentCandidates({ sourceSchoolYearId: '11f746a0-1222-4444-8888-8a0aba160c29', search: 'MAT-25' });
    expect(executed).toHaveLength(1);
    expect(executed[0].sql).toContain("confirmed_year.status IN ('active', 'closed')");
    expect(executed[0].sql).toContain('target_year.id IS NULL');
    expect(executed[0].params).toContain('%MAT-25%');
    expect(executed[0].params).toContain(null);
  });
});
