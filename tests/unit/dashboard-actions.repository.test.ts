import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { DashboardActionsRepository } from '../../src/modules/dashboard-actions/dashboard-actions.repository.js';

const dialect = new PgDialect();

/** Faux db : enregistre le SQL exécuté et répond selon l'état simulé (item ouvert / rejet manuel existants). */
const fakeDb = (state: { open: boolean; dismissed: boolean }) => {
  const statements: string[] = [];
  return {
    statements,
    db: {
      execute: async (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
        const text = dialect.sqlToQuery(query).sql.replace(/\s+/g, ' ').trim();
        statements.push(text);
        if (text.startsWith('UPDATE dashboard_action_items SET priority')) return { rows: state.open ? [{ id: 'x' }] : [] };
        if (text.startsWith('SELECT 1 FROM dashboard_action_items')) return { rows: state.dismissed ? [{ '?column?': 1 }] : [] };
        return { rows: [] };
      },
    },
  };
};
const run = (state: { open: boolean; dismissed: boolean }, items: Array<{ referenceId: string | null; priority: 'low' | 'medium' | 'high'; message?: string }>) => {
  const fake = fakeDb(state);
  const repository = new DashboardActionsRepository(fake.db as never);
  return repository.replaceType('salary_pending', items).then(() => fake.statements);
};
const item = { referenceId: null, priority: 'medium' as const, message: '2 fiches' };

describe('DashboardActionsRepository.replaceType', () => {
  it('condition toujours vraie et item ouvert : mise à jour en place, aucune insertion', async () => {
    const sqlLog = await run({ open: true, dismissed: false }, [item]);
    expect(sqlLog.some((s) => s.startsWith('INSERT'))).toBe(false);
  });

  it('condition vraie sans item ouvert : insertion', async () => {
    const sqlLog = await run({ open: false, dismissed: false }, [item]);
    expect(sqlLog.some((s) => s.startsWith('INSERT'))).toBe(true);
  });

  it("alerte écartée par le directeur alors que la condition persiste : pas de réapparition", async () => {
    const sqlLog = await run({ open: false, dismissed: true }, [item]);
    expect(sqlLog.some((s) => s.startsWith('INSERT'))).toBe(false);
  });

  it('condition disparue : résout les items ouverts et oublie les rejets manuels, sans supprimer', async () => {
    const sqlLog = await run({ open: false, dismissed: true }, []);
    expect(sqlLog.some((s) => s.startsWith('UPDATE dashboard_action_items SET resolved_at = NOW()'))).toBe(true);
    expect(sqlLog.some((s) => s.startsWith('UPDATE dashboard_action_items SET resolved_by_user_id = NULL'))).toBe(true);
    expect(sqlLog.some((s) => s.startsWith('DELETE') || s.startsWith('INSERT'))).toBe(false);
  });
});

describe('DashboardActionsRepository.listBlockedClasses', () => {
  it("ne retient que les périodes dont la revue est ouverte et les classes non clôturées", async () => {
    const statements: string[] = [];
    const db = { execute: async (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
      statements.push(dialect.sqlToQuery(query).sql.replace(/\s+/g, ' '));
      return { rows: [{ class_id: 'c1', class_name: '3ème A', period_label: 'Trimestre 2', incomplete: 1 }] };
    } };
    const result = await new DashboardActionsRepository(db as never).listBlockedClasses(5);
    expect(result).toEqual([{ classId: 'c1', className: '3ème A', periodLabel: 'Trimestre 2', incomplete: 1 }]);
    // Un trimestre à venir (revue pas encore ouverte) ne bloque rien.
    expect(statements[0]).toContain('gp.review_start_date <=');
    expect(statements[0]).toContain('grading_period_class_closures');
  });
});
