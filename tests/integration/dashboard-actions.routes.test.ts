import { describe, expect, it } from 'vitest';

import { withTenantSchema } from '../../src/shared/database/db.js';
import { buildDashboardActionsService } from '../../src/modules/dashboard-actions/dashboard-actions.service.js';
import { getAuthHeaders, queryTenant, request, tenantTable, TEST_SCHEMA_NAME } from './setup.js';

const suffix = String(Date.now());

type IdRow = { id: string };

describe('dashboard action items integration (7b)', () => {
  it('expose les indicateurs consolidés par niveau pour la direction', async () => {
    const headers = await getAuthHeaders('director');

    const response = await request()
      .get('/api/v1/dashboard/pilotage')
      .set(headers);

    expect(response.status).toBe(200);
    expect(response.body.population).toEqual(expect.objectContaining({
      activeStudents: expect.any(Number),
      activeTeachers: expect.any(Number),
      activeClasses: expect.any(Number),
    }));
    expect(response.body.risks).toEqual(expect.objectContaining({
      studentAbsences: expect.any(Number),
      studentGrades: expect.any(Number),
      studentPayments: expect.any(Number),
      teacherAbsences: expect.any(Number),
    }));
    expect(Array.isArray(response.body.academic)).toBe(true);
  });

  it('génère, expose et résout des items croisés pour la direction', async () => {
    const headers = await getAuthHeaders('director');

    // Élèves à risque (warning/critical) → items student_at_risk
    await queryTenant(`UPDATE ${tenantTable('school_years')} SET status='closed' WHERE status='active'`);
    const years = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('school_years')} (label, start_date, end_date, end_of_year_review_start_date, status)
       VALUES ($1, '2105-09-01', '2106-06-30', '2106-05-01', 'active') RETURNING id::text`,
      [`da-${suffix}`]
    );
    const levels = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('levels')} (name, order_index, is_exam_class) VALUES ($1, 99960, false) RETURNING id::text`,
      [`DA level ${suffix}`]
    );
    const classes = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('classes')} (name, level_id, school_year_id, is_active)
       VALUES ($1, $2::uuid, $3::uuid, true) RETURNING id::text`,
      [`DA class ${suffix}`, levels[0]!.id, years[0]!.id]
    );
    const students = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule)
       VALUES ($1::uuid, 'Risk', 'One', $2), ($1::uuid, 'Risk', 'Two', $3) RETURNING id::text`,
      [classes[0]!.id, `DA-1-${suffix}`, `DA-2-${suffix}`]
    );
    for (const studentId of students) {
      await queryTenant(
        `INSERT INTO ${tenantTable('student_risk_status')}
           (student_id, absences_signal, grades_signal, payment_signal, risk_score, level, computed_at)
         VALUES ($1::uuid, true, true, true, 3, 'critical', NOW())`,
        [studentId.id]
      );
    }

    // Génération complète (providers réels du schéma de test)
    const generated = await withTenantSchema(TEST_SCHEMA_NAME ?? '', async (tenantDb) =>
      buildDashboardActionsService(tenantDb).generateAll({
        weeklyAbsenceCount: 4,
        salaryPendingCount: 0,
        pendingValidations: 2,
        commissionOverdueCount: 0,
      })
    );
    expect(generated.generated).toBeGreaterThanOrEqual(2);

    // Une condition persistante est recalculée à chaque cycle du worker : les
    // items précédents deviennent historiques et ne doivent pas bloquer l'insert.
    await expect(
      withTenantSchema(TEST_SCHEMA_NAME ?? '', async (tenantDb) =>
        buildDashboardActionsService(tenantDb).generateAll({
          weeklyAbsenceCount: 4,
          salaryPendingCount: 0,
          pendingValidations: 2,
          commissionOverdueCount: 0,
        })
      )
    ).resolves.toEqual(expect.objectContaining({ generated: expect.any(Number) }));

    const validationItemStates = await queryTenant<{ is_open: boolean }>(
      `SELECT resolved_at IS NULL AS is_open
       FROM ${tenantTable('dashboard_action_items')}
       WHERE type = 'validations_pending'`
    );
    expect(validationItemStates.filter((item) => item.is_open)).toHaveLength(1);
    expect(validationItemStates.filter((item) => !item.is_open)).toHaveLength(1);

    // Lecture direction : les items sont triés par priorité
    const list = await request().get('/api/v1/dashboard/action-items').set(headers);
    expect(list.status).toBe(200);
    const open = list.body.items as Array<{ id: string; type: string; priority: string; resolved_at?: string | null; resolvedAt?: string | null }>;
    expect(open.some((item) => item.type === 'teacher_absences_high' && item.priority === 'high')).toBe(true);
    expect(open.some((item) => item.type === 'validations_pending' && item.priority === 'high')).toBe(true);
    expect(open.some((item) => item.type === 'student_at_risk')).toBe(true);

    // Résolution persistée côté serveur
    const target = open.find((item) => item.type === 'student_at_risk')!;
    const resolve = await request()
      .post(`/api/v1/dashboard/action-items/${target.id}/resolve`)
      .set(headers);
    expect(resolve.status).toBe(200);

    const after = await request().get('/api/v1/dashboard/action-items').set(headers);
    const stillOpen = (after.body.items as Array<{ type: string }>).filter(
      (item) => item.type === 'student_at_risk',
    );
    expect(stillOpen).toHaveLength(0);
  });
});
