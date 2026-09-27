import { sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { StudentsRepository } from '../../src/modules/students/students.repository.js';

type SqlChunkLike = {
  value?: unknown;
  queryChunks?: unknown[];
};

const renderSql = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(renderSql).join('');
  if (typeof value !== 'object' || value === null) return '';

  const chunk = value as SqlChunkLike;
  if (Array.isArray(chunk.value)) return chunk.value.map(renderSql).join('');
  if (Array.isArray(chunk.queryChunks)) return chunk.queryChunks.map(renderSql).join('');
  return '';
};

const buildRepository = () => {
  let capturedSql = '';
  const db = {
    execute: vi.fn(async (query: ReturnType<typeof sql>) => {
      capturedSql = renderSql(query);
      return { rows: [] };
    }),
  };

  return {
    repository: new StudentsRepository(db, { execute: vi.fn() }),
    getCapturedSql: () => capturedSql,
  };
};

describe('StudentsRepository.getStudentAbsenceStats()', () => {
  it('calcule le total planifié par jour sur la période et normalise la matière', async () => {
    const { repository, getCapturedSql } = buildRepository();

    await repository.getStudentAbsenceStats({
      from: '2026-06-01',
      to: '2026-08-30',
      subject: ' Mathématiques ',
      min_absences: 1,
    });

    const query = getCapturedSql();
    expect(query).toContain('active_period_by_day');
    expect(query).toContain('valid_from <= d.date');
    expect(query).toContain('valid_to >= d.date');
    expect(query).toContain('regexp_replace');
    expect(query).not.toContain('WITH active_period AS');
  });
});

describe('StudentsRepository.listStudents()', () => {
  it('exige une inscription confirmée dans la requête de liste et de total', async () => {
    const queries: string[] = [];
    const db = { execute: vi.fn(async (query: ReturnType<typeof sql>) => {
      queries.push(renderSql(query));
      return { rows: [] };
    }) };
    await new StudentsRepository(db).listStudents({ page: 1, limit: 20 });
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query).toContain("e.status = 'confirmed'");
      expect(query).toContain('e.student_id = s.id');
      expect(query).toContain("sy.status = 'active'");
      expect(query).not.toContain("e.status IN ('pending_cashier', 'pending_dossier')");
    }
  });

  it('réserve les profils à la préparation et laisse les dossiers existants au parcours inscription/réinscription', async () => {
    const { repository, getCapturedSql } = buildRepository();
    await repository.listStudents({ page: 1, limit: 10, search: 'Historique' }, 'profiles');
    const query = getCapturedSql();
    expect(query).toContain('NOT EXISTS');
    expect(query).toContain('e.student_id = s.id');
    expect(query).not.toContain("e.status = 'confirmed'");
  });

  it('préserve la recherche financière des anciens dossiers sans les inscrire dans la liste scolaire', async () => {
    const { repository, getCapturedSql } = buildRepository();
    await repository.listStudents({ page: 1, limit: 10, search: 'Ancien' }, 'financial');
    expect(getCapturedSql()).toContain('FROM student_financial_status');
    expect(getCapturedSql()).toContain('FROM payments');
    expect(getCapturedSql()).toContain('FROM enrollments e WHERE e.student_id = s.id');
    expect(getCapturedSql()).not.toContain("sy.status = 'active'");
  });
});
