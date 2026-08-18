import { describe, expect, it } from 'vitest';

import {
  getAuthHeaders,
  getSeedContext,
  queryTenant,
  request,
  tenantTable,
} from './setup.js';

describe('class decisions integration', () => {
  it('ouvre la revue à la date seuil puis enregistre la décision et son validateur', async () => {
    const headers = await getAuthHeaders('director');
    const context = getSeedContext();

    const schoolYears = await queryTenant<{ id: string }>(
      `
        INSERT INTO ${tenantTable('school_years')} (label, start_date, end_date, status)
        VALUES ('09/2098 - 06/2099', '2098-09-01', '2099-06-30', 'active')
        RETURNING id
      `
    );
    const schoolYearId = schoolYears[0]!.id;

    const levels = await queryTenant<{ id: string }>(
      `
        INSERT INTO ${tenantTable('levels')} (name, order_index, is_exam_class)
        VALUES ('6ème revue', 7, false)
        RETURNING id
      `
    );
    const levelId = levels[0]!.id;

    const classes = await queryTenant<{ id: string }>(
      `
        INSERT INTO ${tenantTable('classes')} (name, level_id, school_year_id, is_active)
        VALUES ('6ème revue A', $1::uuid, $2::uuid, true)
        RETURNING id
      `,
      [levelId, schoolYearId]
    );
    const students = await queryTenant<{ id: string }>(
      `
        INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule, is_active)
        VALUES ($1::uuid, 'Aminata', 'Koné', 'MAT-REVUE-001', true)
        RETURNING id
      `,
      [classes[0]!.id]
    );
    const studentId = students[0]!.id;

    const initialStatus = await request()
      .get('/api/v1/class-decisions/review-status')
      .set(headers);
    expect(initialStatus.status).toBe(200);
    expect(initialStatus.body.visible).toBe(false);

    const closedList = await request().get('/api/v1/class-decisions').set(headers);
    expect(closedList.status).toBe(403);
    expect(closedList.body.code).toBe('END_OF_YEAR_REVIEW_NOT_OPEN');

    const updateDate = await request()
      .patch(`/api/v1/school-years/${schoolYearId}`)
      .set(headers)
      .send({ endOfYearReviewStartDate: '2000-01-01' });
    expect(updateDate.status).toBe(200);

    const list = await request().get('/api/v1/class-decisions').set(headers);
    expect(list.status).toBe(200);
    expect(list.body.decisions).toEqual([
      expect.objectContaining({
        studentId,
        suggestedDecision: null,
        finalDecision: null,
      }),
    ]);

    const validation = await request()
      .patch(`/api/v1/class-decisions/${studentId}`)
      .set(headers)
      .send({ finalDecision: 'promoted', nextLevelId: levelId });
    expect(validation.status).toBe(200);
    expect(validation.body.decision).toMatchObject({
      studentId,
      finalDecision: 'promoted',
      nextLevelId: levelId,
    });

    const stored = await queryTenant<{
      final_decision: string;
      validated_by_user_id: string;
      validated_at: Date;
    }>(
      `
        SELECT final_decision, validated_by_user_id, validated_at
        FROM ${tenantTable('class_decisions')}
        WHERE student_id = $1::uuid AND school_year_id = $2::uuid
      `,
      [studentId, schoolYearId]
    );
    expect(stored[0]).toMatchObject({
      final_decision: 'promoted',
      validated_by_user_id: context.directorUserId,
    });
    expect(stored[0]?.validated_at).toBeTruthy();
  });

  it('ne propose aucun endpoint de création ou activation au directeur', async () => {
    const headers = await getAuthHeaders('director');
    const response = await request()
      .post('/api/v1/school-years')
      .set(headers)
      .send({
        label: '09/2099 - 06/2100',
        startDate: '2099-09-01',
        endDate: '2100-06-30',
        status: 'active',
      });

    expect(response.status).toBe(404);
  });
});
