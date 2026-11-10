import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { EnrollmentsRepository } from '../../src/modules/enrollments/enrollments.repository.js';

const dialect = new PgDialect();

const capture = async (run: (repository: EnrollmentsRepository) => Promise<unknown>): Promise<string> => {
  const statements: string[] = [];
  const db = { execute: async (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
    statements.push(dialect.sqlToQuery(query).sql.replace(/\s+/g, ' ').trim());
    return { rows: [] };
  } };
  await run(new EnrollmentsRepository(db as never));
  return statements.join('\n');
};

describe('documents requis : la liste courante fait foi pour tous les dossiers de l’année active', () => {
  it('un nouveau document requis est ajouté « manquant » aux dossiers confirmés, pas seulement aux dossiers ouverts', async () => {
    const sqlText = await capture((repository) => repository.syncRequiredDocumentToOpenEnrollments('doc-1', 'level-1'));
    expect(sqlText).toContain("sy.status = 'active'");
    expect(sqlText).not.toContain("'pending_cashier'");
    expect(sqlText).toContain('ON CONFLICT (student_id, document_type_id) DO NOTHING');
  });

  it('la consultation du dossier d’un élève rattrape les documents requis ajoutés depuis, quel que soit le statut de son inscription', async () => {
    const sqlText = await capture((repository) => repository.syncActiveRequiredDocumentsForStudent('student-1'));
    expect(sqlText).toContain("sy.status = 'active'");
    expect(sqlText).not.toContain("'blocked_unpaid'");
    expect(sqlText).toContain('ON CONFLICT (student_id, document_type_id) DO NOTHING');
  });

  it('la liste affichée exclut les documents archivés (non fournis) et garde les pièces déjà fournies', async () => {
    const sqlText = await capture((repository) => repository.listStudentDocuments('student-1'));
    expect(sqlText).toContain('rdt.is_active');
    expect(sqlText).toContain("sd.status = 'provided'");
  });
});
