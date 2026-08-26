import { describe, expect, it } from 'vitest';

import { signAccessToken } from '../../src/modules/auth/auth.service.js';
import { queryTenant, request, tenantTable, TEST_SCHEMA_NAME } from './setup.js';

const suffix = String(Date.now());

type IdRow = { id: string };

describe('parent overview integration (17b)', () => {
  let parentHeaders: Record<string, string>;

  it('agrège finances et dernier bulletin publié par enfant', async () => {
    // Année active + classe + deux élèves aux statuts différents
    await queryTenant(`UPDATE ${tenantTable('school_years')} SET status='closed' WHERE status='active'`);
    const years = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('school_years')} (label, start_date, end_date, end_of_year_review_start_date, status)
       VALUES ($1, '2101-09-01', '2102-06-30', '2102-05-01', 'active') RETURNING id::text`,
      [`po-${suffix}`]
    );
    const yearId = years[0]!.id;
    const levels = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('levels')} (name, order_index, is_exam_class) VALUES ($1, 99900, false) RETURNING id::text`,
      [`PO level ${suffix}`]
    );
    const classes = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('classes')} (name, level_id, school_year_id, is_active)
       VALUES ($1, $2::uuid, $3::uuid, true) RETURNING id::text`,
      [`PO class ${suffix}`, levels[0]!.id, yearId]
    );
    const students = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule)
       VALUES ($1::uuid, 'Late', 'Kid', $2),
              ($1::uuid, 'Clean', 'Kid', $3)
       RETURNING id::text`,
      [classes[0]!.id, `PO-L-${suffix}`, `PO-C-${suffix}`]
    );
    const lateStudentId = students[0]!.id;
    const cleanStudentId = students[1]!.id;

    // Cache financier : un en retard, un à jour (responsabilité 6a)
    await queryTenant(
      `INSERT INTO ${tenantTable('student_financial_status')}
         (student_id, school_year_id, total_expected_to_date, total_paid, total_due_year, status, days_late, last_computed_at)
       VALUES ($1::uuid, $2::uuid, 150000, 50000, 300000, 'late', 21, NOW()),
              ($3::uuid, $2::uuid, 150000, 150000, 300000, 'up_to_date', NULL, NOW())`,
      [lateStudentId, yearId, cleanStudentId]
    );

    // Bulletin publié pour l'élève à jour uniquement
    const periods = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('grading_periods')} (school_year_id, type, order_index, label, start_date, end_date)
       VALUES ($1::uuid, 'trimester', 1, 'T1 po', '2101-09-01', '2101-12-15') RETURNING id::text`,
      [yearId]
    );
    await queryTenant(
      `INSERT INTO ${tenantTable('report_cards')}
         (student_id, class_id, grading_period_id, general_average, rank,
          class_average, class_min_average, class_max_average, class_headcount,
          status, generated_at, published_at, published_by_user_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 14.5, 3, 12.5, 8, 16, 24,
               'published', NOW(), NOW(), NULL)`,
      [cleanStudentId, classes[0]!.id, periods[0]!.id]
    );

    // Compte parent réel + liens vers les deux enfants (mécanique DB du portail)
    const parents = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('parents')} (full_name, phone, password_hash, is_active, must_change_password)
       VALUES ('Parent Test', '2250760000001', 'not-used', true, false) RETURNING id::text`
    );
    const parentId = parents[0]!.id;
    await queryTenant(
      `INSERT INTO ${tenantTable('parent_student_links')} (parent_id, student_id)
       VALUES ($1::uuid, $2::uuid), ($1::uuid, $3::uuid)`,
      [parentId, lateStudentId, cleanStudentId]
    );

    // Token parent multi-enfants
    const token = await signAccessToken({
      sub: parentId,
      role: 'parent',
      schemaName: TEST_SCHEMA_NAME,
      studentIds: [lateStudentId, cleanStudentId],
    });
    parentHeaders = { authorization: `Bearer ${token}` };

    const headers = { authorization: parentHeaders.authorization };

    // Enfant en retard : finances visibles, pas de bulletin
    const lateOverview = await request()
      .get(`/api/v1/parent/students/${lateStudentId}/overview`)
      .set(headers);
    expect(lateOverview.status).toBe(200);
    expect(lateOverview.body.financial).toMatchObject({
      status: 'late',
      remainingDue: 250_000,
    });
    expect(lateOverview.body.latestPublishedReportCard).toBeNull();

    // Enfant à jour : finances OK + bulletin publié agrégé
    const cleanOverview = await request()
      .get(`/api/v1/parent/students/${cleanStudentId}/overview`)
      .set(headers);
    expect(cleanOverview.status).toBe(200);
    expect(cleanOverview.body.financial.status).toBe('up_to_date');
    expect(cleanOverview.body.latestPublishedReportCard).toMatchObject({
      periodLabel: 'T1 po',
      generalAverage: 14.5,
      rank: 3,
      classHeadcount: 24,
    });
  });

  it("refuse l'accès à un enfant hors du compte parent", async () => {
    const students = await queryTenant<IdRow>(
      `SELECT s.id::text FROM ${tenantTable('students')} s
       INNER JOIN ${tenantTable('classes')} c ON c.id = s.class_id
       WHERE c.name LIKE 'PO class %' ORDER BY s.created_at ASC LIMIT 1`
    );

    const foreignToken = await signAccessToken({
      sub: '00000000-0000-4000-8000-000000000002',
      role: 'parent',
      schemaName: TEST_SCHEMA_NAME,
      studentIds: [],
    });

    const response = await request()
      .get(`/api/v1/parent/students/${students[0]!.id}/overview`)
      .set('authorization', `Bearer ${foreignToken}`);
    expect([403]).toContain(response.status);
  });
});
