import { describe, expect, it } from 'vitest';

import {
  getAuthHeaders,
  getSeedContext,
  queryTenant,
  request,
  tenantTable,
} from './setup.js';

describe('academic structure integration', () => {
  it('crée une classe rattachée au niveau, à l’année active et au professeur principal', async () => {
    const headers = await getAuthHeaders('director');
    const context = getSeedContext();

    const schoolYearRows = await queryTenant<{ id: string }>(
      `
        INSERT INTO ${tenantTable('school_years')} (label, start_date, end_date, status)
        VALUES ($1, $2::date, $3::date, 'active')
        RETURNING id
      `,
      ['09/2026 - 06/2027', '2026-09-01', '2027-06-30']
    );
    const schoolYearId = schoolYearRows[0]!.id;

    const legacyClassRows = await queryTenant<{ id: string }>(
      `
        INSERT INTO ${tenantTable('classes')} (name, level, student_count, is_active)
        VALUES ('5ème Héritée', '5ème', 99, true)
        RETURNING id
      `
    );
    const legacyClassId = legacyClassRows[0]!.id;
    await queryTenant(
      `
        INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule, is_active)
        VALUES ($1::uuid, 'Fatou', 'Yao', 'MAT-LEGACY-001', true)
      `,
      [legacyClassId]
    );

    const forbiddenCreationResponse = await request()
      .post('/api/v1/school-years')
      .set(headers)
      .send({
        label: '09/2027 - 06/2028',
        startDate: '2027-09-01',
        endDate: '2028-06-30',
        status: 'active',
      });
    expect(forbiddenCreationResponse.status).toBe(404);

    const levelResponse = await request()
      .post('/api/v1/levels')
      .set(headers)
      .send({ name: '6ème', orderIndex: 7, isExamClass: false });
    expect(levelResponse.status).toBe(201);
    const levelId = levelResponse.body.level.id as string;

    const classResponse = await request()
      .post('/api/v1/classes')
      .set(headers)
      .send({
        name: '6ème A',
        levelId,
        homeroomTeacherId: context.teacherId,
      });

    expect(classResponse.status).toBe(201);
    expect(classResponse.body.class).toMatchObject({
      name: '6ème A',
      level: { id: levelId, name: '6ème' },
      schoolYear: { id: schoolYearId, label: '09/2026 - 06/2027' },
      homeroomTeacher: { id: context.teacherId },
      isActive: true,
    });

    const classId = classResponse.body.class.id as string;

    const restrictedUpdateResponse = await request()
      .patch(`/api/v1/school-years/${schoolYearId}`)
      .set(headers)
      .send({ status: 'closed' });
    expect(restrictedUpdateResponse.status).toBe(400);

    const reviewDateResponse = await request()
      .patch(`/api/v1/school-years/${schoolYearId}`)
      .set(headers)
      .send({ endOfYearReviewStartDate: '2026-08-01' });
    expect(reviewDateResponse.status).toBe(200);
    expect(reviewDateResponse.body.schoolYear).toMatchObject({
      id: schoolYearId,
      status: 'active',
      endOfYearReviewStartDate: '2026-08-01',
    });

    const studentRows = await queryTenant<{ id: string }>(
      `
        INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule, is_active)
        VALUES ($1::uuid, 'Aminata', 'Koné', 'MAT-FIN-001', true)
        RETURNING id
      `,
      [classId]
    );
    const studentId = studentRows[0]!.id;

    const reviewStatusResponse = await request()
      .get('/api/v1/class-decisions/review-status')
      .set(headers);
    expect(reviewStatusResponse.status).toBe(200);
    expect(reviewStatusResponse.body.visible).toBe(true);

    const decisionsResponse = await request()
      .get('/api/v1/class-decisions')
      .set(headers);
    expect(decisionsResponse.status).toBe(200);
    expect(decisionsResponse.body.decisions).toEqual([
      expect.objectContaining({
        studentId,
        suggestedDecision: null,
        finalDecision: null,
      }),
    ]);

    const validationResponse = await request()
      .patch(`/api/v1/class-decisions/${studentId}`)
      .set(headers)
      .send({ finalDecision: 'promoted', nextLevelId: levelId });
    expect(validationResponse.status).toBe(200);
    expect(validationResponse.body.decision).toMatchObject({
      studentId,
      finalDecision: 'promoted',
      nextLevelId: levelId,
    });

    const storedDecisions = await queryTenant<{
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
    expect(storedDecisions[0]).toMatchObject({
      final_decision: 'promoted',
      validated_by_user_id: context.directorUserId,
    });
    expect(storedDecisions[0]?.validated_at).toBeTruthy();
    const storedRows = await queryTenant<{
      level_id: string;
      school_year_id: string;
      homeroom_teacher_id: string;
      is_active: boolean;
    }>(
      `
        SELECT level_id, school_year_id, homeroom_teacher_id, is_active
        FROM ${tenantTable('classes')}
        WHERE id = $1::uuid
      `,
      [classId]
    );
    expect(storedRows[0]).toEqual({
      level_id: levelId,
      school_year_id: schoolYearId,
      homeroom_teacher_id: context.teacherId,
      is_active: true,
    });

    const listResponse = await request().get('/api/v1/classes').set(headers);
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.activeSchoolYear.id).toBe(schoolYearId);
    expect(listResponse.body.schoolYear.id).toBe(schoolYearId);
    expect(listResponse.body.classes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: classId, name: '6ème A' }),
        expect.objectContaining({
          id: legacyClassId,
          name: '5ème Héritée',
          studentCount: 1,
          level: expect.objectContaining({ name: '5ème' }),
          schoolYear: expect.objectContaining({ id: schoolYearId }),
        }),
      ])
    );

    const adoptedLegacyRows = await queryTenant<{
      level_name: string;
      school_year_id: string;
    }>(
      `
        SELECT l.name AS level_name, c.school_year_id
        FROM ${tenantTable('classes')} c
        INNER JOIN ${tenantTable('levels')} l ON l.id = c.level_id
        WHERE c.id = $1::uuid
      `,
      [legacyClassId]
    );
    expect(adoptedLegacyRows[0]).toEqual({
      level_name: '5ème',
      school_year_id: schoolYearId,
    });

    const updateResponse = await request()
      .patch(`/api/v1/classes/${classId}`)
      .set(headers)
      .send({ name: '6ème B', homeroomTeacherId: null });
    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body.class).toMatchObject({
      id: classId,
      name: '6ème B',
      homeroomTeacher: null,
    });

    const archiveResponse = await request()
      .delete(`/api/v1/classes/${classId}`)
      .set(headers);
    expect(archiveResponse.status).toBe(200);
    expect(archiveResponse.body.class.isActive).toBe(false);

    const archivedRows = await queryTenant<{ is_active: boolean }>(
      `SELECT is_active FROM ${tenantTable('classes')} WHERE id = $1::uuid`,
      [classId]
    );
    expect(archivedRows[0]?.is_active).toBe(false);

    const listAfterArchiveResponse = await request().get('/api/v1/classes').set(headers);
    expect(listAfterArchiveResponse.status).toBe(200);
    expect(listAfterArchiveResponse.body.classes).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: classId })])
    );

    const filteredListResponse = await request()
      .get(`/api/v1/classes?schoolYearId=${schoolYearId}`)
      .set(headers);
    expect(filteredListResponse.status).toBe(200);
    expect(filteredListResponse.body.schoolYear.id).toBe(schoolYearId);

    const invalidFilterResponse = await request()
      .get('/api/v1/classes?schoolYearId=not-a-uuid')
      .set(headers);
    expect(invalidFilterResponse.status).toBe(400);
    expect(invalidFilterResponse.body.code).toBe('VALIDATION_ERROR');
  });

  it('respecte les permissions classes et school_years pour un staff sans poste', async () => {
    const staffHeaders = await getAuthHeaders('staff');

    const classesResponse = await request().get('/api/v1/classes').set(staffHeaders);
    expect(classesResponse.status).toBe(403);
    expect(classesResponse.body.code).toBe('FORBIDDEN');

    const schoolYearsResponse = await request().get('/api/v1/school-years').set(staffHeaders);
    expect(schoolYearsResponse.status).toBe(403);
    expect(schoolYearsResponse.body.code).toBe('FORBIDDEN');

    const decisionsResponse = await request().get('/api/v1/class-decisions').set(staffHeaders);
    expect(decisionsResponse.status).toBe(403);
    expect(decisionsResponse.body.code).toBe('FORBIDDEN');
  });
});
