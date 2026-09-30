import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { confirmedSchoolClassCount, confirmedSchoolStudent } from '../../src/shared/database/confirmed-school-membership.js';

const dialect = new PgDialect();

describe('confirmed school membership SQL', () => {
  it('requires an active profile, a confirmed enrollment and an active class in the requested year and class', () => {
    const query = dialect.sqlToQuery(sql`SELECT ${confirmedSchoolStudent(
      sql`target.id`, sql`${'year-id'}::uuid`, sql`${'class-id'}::uuid`
    )}`);
    expect(query.sql).toContain('membership_student.is_active = true');
    expect(query.sql).toContain("membership_enrollment.status = 'confirmed'");
    expect(query.sql).toContain('membership_class.is_active = true');
    expect(query.sql).toContain('membership_class.school_year_id = membership_enrollment.school_year_id');
    expect(query.sql).toContain('membership_enrollment.class_id = ');
    expect(query.sql).not.toContain('students_with_class');
    expect(query.params).toEqual(['year-id', 'class-id']);
  });

  it('can retain inactive historical classes only when the caller explicitly requests them', () => {
    const query = dialect.sqlToQuery(sql`SELECT ${confirmedSchoolStudent(sql`target.id`, sql`target.year_id`, undefined, false)}`);
    expect(query.sql).not.toContain('membership_class.is_active = true');
  });

  it('counts distinct students from confirmed enrollments and reuses the membership rule', () => {
    const query = dialect.sqlToQuery(sql`SELECT ${confirmedSchoolClassCount(sql`c.id`, sql`c.school_year_id`)}`);
    expect(query.sql).toContain('COUNT(DISTINCT counted_enrollment.student_id)');
    expect(query.sql).toContain("counted_enrollment.status = 'confirmed'");
    expect(query.sql).toContain('membership_student.is_active = true');
    expect(query.sql).toContain('membership_class.is_active = true');
  });
});
