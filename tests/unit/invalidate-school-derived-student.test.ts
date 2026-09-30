import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import { invalidateSchoolDerivedStudent } from '../../src/shared/database/invalidate-school-derived-student.js';

describe('confirmation invalidates only derived school data', () => {
  it('clears averages for the confirmed year and the risk snapshot while retaining source records', async () => {
    const queries: string[] = [];
    const dialect = new PgDialect();
    const db = { execute: vi.fn(async (query: ReturnType<typeof sql>) => {
      queries.push(dialect.sqlToQuery(query).sql);
      return { rows: [] };
    }) };
    await invalidateSchoolDerivedStudent(db, 'student-id', 'year-id');
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain('DELETE FROM student_period_averages');
    expect(queries[0]).toContain('gp.school_year_id');
    expect(queries[1]).toContain('DELETE FROM student_risk_status');
    expect(queries.join(' ')).not.toMatch(/DELETE FROM (students|enrollments|evaluation_grades|attendances_student|documents)/);
  });
});
