import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTenantSchema } from '../../src/shared/database/tenant-init.js';
import { getAuthHeaders, getSeedContext, queryPublic, queryTenant, request } from './setup.js';

describe('consultation direction des évaluations', () => {
  it('applique les permissions, les relations, les filtres et la pagination avec les notes manquantes', async () => {
    const suffix = Date.now().toString(36);
    const teacherId = getSeedContext().teacherId;
    const director = await getAuthHeaders('director');
    const teacher = await getAuthHeaders('teacher');
    const staff = await getAuthHeaders('staff');
    const year = (await queryTenant<{ id: string }>(`
      INSERT INTO school_years (label, start_date, end_date, end_of_year_review_start_date, status)
      VALUES ($1, '2020-09-01', '2021-06-30', '2021-05-31', 'draft') RETURNING id`, [`2020-${suffix}`]))[0]!.id;
    const otherYear = (await queryTenant<{ id: string }>(`
      INSERT INTO school_years (label, start_date, end_date, end_of_year_review_start_date, status)
      VALUES ($1, '2021-09-01', '2022-06-30', '2022-05-31', 'draft') RETURNING id`, [`2021-${suffix}`]))[0]!.id;
    const futureYear = (await queryTenant<{ id: string }>(`
      INSERT INTO school_years (label, start_date, end_date, end_of_year_review_start_date, status)
      VALUES ($1, CURRENT_DATE + 30, CURRENT_DATE + 400, CURRENT_DATE + 350, 'draft') RETURNING id`, [`future-${suffix}`]))[0]!.id;
    const level = (await queryTenant<{ id: string }>(`
      INSERT INTO levels (name, order_index, is_exam_class) VALUES ($1, 901, false) RETURNING id`, [`Niveau revue ${suffix}`]))[0]!.id;
    const otherLevel = (await queryTenant<{ id: string }>(`
      INSERT INTO levels (name, order_index, is_exam_class) VALUES ($1, 902, false) RETURNING id`, [`Autre niveau ${suffix}`]))[0]!.id;
    const classId = (await queryTenant<{ id: string }>(`
      INSERT INTO classes (name, level_id, school_year_id) VALUES ($1, $2, $3) RETURNING id`, [`Classe revue ${suffix}`, level, year]))[0]!.id;
    const otherClass = (await queryTenant<{ id: string }>(`
      INSERT INTO classes (name, level_id, school_year_id) VALUES ($1, $2, $3) RETURNING id`, [`Autre classe ${suffix}`, otherLevel, otherYear]))[0]!.id;
    const secondaryClass = (await queryTenant<{ id: string }>(`
      INSERT INTO classes (name, level_id, school_year_id) VALUES ($1, $2, $3) RETURNING id`, [`Classe parallèle ${suffix}`, otherLevel, year]))[0]!.id;
    const futureClass = (await queryTenant<{ id: string }>(`
      INSERT INTO classes (name, level_id, school_year_id) VALUES ($1, $2, $3) RETURNING id`, [`Classe future ${suffix}`, level, futureYear]))[0]!.id;
    const secondaryUser = (await queryTenant<{ id: string }>(`
      INSERT INTO users (role, name, password_hash) VALUES ('teacher', 'Professeur parallèle', 'hash') RETURNING id`, []))[0]!.id;
    const secondaryTeacher = (await queryTenant<{ id: string }>(`
      INSERT INTO teachers (user_id, username, type) VALUES ($1, $2, 'vacataire') RETURNING id`, [secondaryUser, `c21.${suffix}`]))[0]!.id;
    const subject = (await queryTenant<{ id: string }>(`
      INSERT INTO subjects (level_id, name, coefficient) VALUES ($1, 'Mathématiques', 4) RETURNING id`, [level]))[0]!.id;
    const otherSubject = (await queryTenant<{ id: string }>(`
      INSERT INTO subjects (level_id, name, coefficient) VALUES ($1, 'Français', 2) RETURNING id`, [level]))[0]!.id;
    const otherYearSubject = (await queryTenant<{ id: string }>(`
      INSERT INTO subjects (level_id, name, coefficient) VALUES ($1, 'Sciences', 2) RETURNING id`, [otherLevel]))[0]!.id;
    await queryTenant(`INSERT INTO teacher_subject_assignments (teacher_id, subject_id, class_id)
      VALUES ($1, $2, $3), ($4, $5, $6), ($7, $8, $9)`,
    [teacherId, subject, classId, secondaryTeacher, otherYearSubject, secondaryClass, teacherId, subject, futureClass]);
    const period = (await queryTenant<{ id: string }>(`
      INSERT INTO grading_periods (school_year_id, type, order_index, label, start_date, end_date)
      VALUES ($1, 'trimester', 1, 'Premier trimestre', '2020-09-01', '2020-12-20') RETURNING id`, [year]))[0]!.id;
    const otherPeriod = (await queryTenant<{ id: string }>(`
      INSERT INTO grading_periods (school_year_id, type, order_index, label, start_date, end_date)
      VALUES ($1, 'trimester', 1, 'Premier trimestre', '2021-09-01', '2021-12-20') RETURNING id`, [otherYear]))[0]!.id;
    const futurePeriod = (await queryTenant<{ id: string }>(`
      INSERT INTO grading_periods (school_year_id, type, order_index, label, start_date, end_date)
      VALUES ($1, 'trimester', 1, 'Période future', CURRENT_DATE + 30, CURRENT_DATE + 90) RETURNING id`, [futureYear]))[0]!.id;
    const studentIds: string[] = [];
    for (const number of [1, 2]) {
      const studentId = (await queryTenant<{ id: string }>(`
        INSERT INTO students (matricule, first_name, last_name, is_active)
        VALUES ($1, $2, 'Élève', true) RETURNING id`, [`C21-${suffix}-${number}`, `Test ${number}`]))[0]!.id;
      studentIds.push(studentId);
      await queryTenant(`INSERT INTO enrollments (student_id, class_id, school_year_id, type, status)
        VALUES ($1, $2, $3, 'new_registration', 'confirmed')`, [studentId, classId, year]);
    }
    const legacyStudent = (await queryTenant<{ id: string }>(`
      INSERT INTO students (class_id, matricule, first_name, last_name, is_active)
      VALUES ($1, $2, 'Profil V1', 'Historique', true) RETURNING id`, [classId, `C21-legacy-${suffix}`]))[0]!.id;
    const first = (await queryTenant<{ id: string }>(`
      INSERT INTO evaluations (subject_id, class_id, grading_period_id, teacher_id, type, coefficient, label, evaluation_date)
      VALUES ($1, $2, $3, $4, 'scheduled', 2, 'Devoir noté', '2020-10-01') RETURNING id`, [subject, classId, period, teacherId]))[0]!.id;
    const second = (await queryTenant<{ id: string }>(`
      INSERT INTO evaluations (subject_id, class_id, grading_period_id, teacher_id, type, coefficient, label, evaluation_date)
      VALUES ($1, $2, $3, $4, 'scheduled', 1, 'Devoir incomplet', '2020-09-20') RETURNING id`, [otherSubject, classId, period, teacherId]))[0]!.id;
    const third = (await queryTenant<{ id: string }>(`
      INSERT INTO evaluations (subject_id, class_id, grading_period_id, teacher_id, type, coefficient, label, evaluation_date)
      VALUES ($1, $2, $3, $4, 'scheduled', 1, 'Autre classe', '2020-09-10') RETURNING id`, [otherYearSubject, secondaryClass, period, secondaryTeacher]))[0]!.id;
    await queryTenant(`INSERT INTO evaluation_grades (evaluation_id, student_id, score, max_score, comment)
      VALUES ($1, $2, 14, 20, 'Bien')`, [first, studentIds[0]]);
    for (const [targetStudent, targetSubject, adjustment, date, comment] of [
      [studentIds[0], subject, 3, '2020-10-02', 'Participation'],
      [studentIds[0], otherSubject, -2, '2020-10-03', 'À reprendre'],
      [studentIds[1], subject, 1, '2020-10-04', 'Effort'],
    ] as const) {
      const spontaneous = (await queryTenant<{ id: string }>(`
        INSERT INTO evaluations (subject_id, class_id, grading_period_id, teacher_id, type, coefficient, label, evaluation_date)
        VALUES ($1, $2, $3, $4, 'spontaneous', 1, $5, $6) RETURNING id`,
        [targetSubject, classId, period, teacherId, `Note spontanée ${adjustment > 0 ? '+' : ''}${adjustment}`, date]))[0]!.id;
      await queryTenant(`INSERT INTO evaluation_grades (evaluation_id, student_id, score, max_score, comment)
        VALUES ($1, $2, $3, 20, $4)`, [spontaneous, targetStudent, Math.abs(adjustment), comment]);
    }
    await queryTenant(`INSERT INTO evaluations (subject_id, class_id, grading_period_id, teacher_id, type, coefficient, label)
      VALUES ($1, $2, $3, $4, 'spontaneous', 1, 'Sans note')`, [subject, classId, period, teacherId]);
    await queryTenant(`INSERT INTO evaluations (subject_id, class_id, grading_period_id, teacher_id, type, coefficient, label)
      VALUES ($1, $2, $3, $4, 'spontaneous', 1, 'Autre année')`, [otherYearSubject, otherClass, otherPeriod, teacherId]);

    const path = '/api/v1/academic/evaluations';
    const base = { schoolYearId: year, gradingPeriodId: period };
    expect((await request().get(path).set(teacher).query(base)).status).toBe(403);
    expect((await request().get(path).set(staff).query(base)).status).toBe(403);
    expect((await request().get(`${path}/spontaneous`).set(teacher).query(base)).status).toBe(403);
    expect((await request().get(`${path}/spontaneous`).set(staff).query(base)).status).toBe(403);
    const options = await request().get(`${path}/options`).set(director).query({ schoolYearId: year, gradingPeriodId: period, levelId: level, classId });
    expect(options.status).toBe(200);
    expect(options.body.gradingPeriods.some((item: { id: string }) => item.id === futurePeriod)).toBe(false);
    expect(options.body.gradingPeriods.find((item: { id: string }) => item.id === period).hasEvaluations).toBe(true);
    expect(options.body.subjects.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([subject, otherSubject]));
    expect(options.body.classes.map((item: { id: string }) => item.id)).toEqual([classId]);
    const secondaryOptions = await request().get(`${path}/options`).set(director).query({ schoolYearId: year,
      gradingPeriodId: period, levelId: otherLevel, classId: secondaryClass });
    expect(secondaryOptions.body.subjects.map((item: { id: string }) => item.id)).toEqual([otherYearSubject]);
    expect(secondaryOptions.body.teachers.map((item: { id: string }) => item.id)).toEqual([secondaryTeacher]);
    const subjectOptions = await request().get(`${path}/options`).set(director).query({ schoolYearId: year,
      gradingPeriodId: period, levelId: level, classId, subjectId: subject });
    expect(subjectOptions.body.teachers.map((item: { id: string }) => item.id)).toEqual([teacherId]);
    const futureOptions = await request().get(`${path}/options`).set(director).query({ schoolYearId: futureYear,
      gradingPeriodId: futurePeriod, levelId: level, classId: futureClass, subjectId: subject });
    expect(futureOptions.status).toBe(200);
    expect(futureOptions.body.gradingPeriods.find((item: { id: string }) => item.id === futurePeriod).isFuture).toBe(true);
    expect(futureOptions.body.classes.map((item: { id: string }) => item.id)).toEqual([futureClass]);
    expect(futureOptions.body.subjects.map((item: { id: string }) => item.id)).toContain(subject);
    expect(futureOptions.body.teachers.map((item: { id: string }) => item.id)).toContain(teacherId);
    const all = await request().get(path).set(director).query(base);
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(all.body).toMatchObject({ total: 3, summary: { evaluations: 3, grades: 1, missing: 3 } });
    expect(all.body.items.find((item: { id: string }) => item.id === first)).toMatchObject({
      notes: expect.arrayContaining([expect.objectContaining({ score: 14, maxScore: 20, comment: 'Bien' })]),
    });
    expect(all.body.items.flatMap((item: { notes: Array<{ studentId: string }> }) => item.notes)
      .some((note: { studentId: string }) => note.studentId === legacyStudent)).toBe(false);
    expect(all.body.items.some((item: { id: string }) => item.id === second)).toBe(true);
    expect(all.body.items.some((item: { id: string }) => item.id === third)).toBe(true);
    expect(all.body.items.every((item: { type: string }) => item.type === 'scheduled')).toBe(true);
    const spontaneous = await request().get(`${path}/spontaneous`).set(director).query(base);
    expect(spontaneous.status, JSON.stringify(spontaneous.body)).toBe(200);
    expect(spontaneous.body).toMatchObject({ totalStudents: 2, totalNotes: 3 });
    expect(spontaneous.body.students).toHaveLength(2);
    const firstStudent = spontaneous.body.students.find((item: { id: string }) => item.id === studentIds[0]);
    expect(firstStudent.subjects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: subject, notes: [expect.objectContaining({ adjustment: 3, date: '2020-10-02' })] }),
      expect.objectContaining({ id: otherSubject, notes: [expect.objectContaining({ adjustment: -2, comment: 'À reprendre' })] }),
    ]));
    expect(spontaneous.body.students.some((item: { id: string }) => item.id === legacyStudent)).toBe(false);
    const searched = await request().get(`${path}/spontaneous`).set(director).query({ ...base, studentSearch: 'Test 2' });
    expect(searched.status).toBe(200);
    expect(searched.body).toMatchObject({ totalStudents: 1, totalNotes: 1, students: [{ id: studentIds[1] }] });
    const searchedByMatricule = await request().get(`${path}/spontaneous`).set(director).query({ ...base, studentSearch: `C21-${suffix}-1` });
    expect(searchedByMatricule.body).toMatchObject({ totalStudents: 1, totalNotes: 2, students: [{ id: studentIds[0] }] });
    expect((await request().get(`${path}/spontaneous`).set(director).query({ ...base, studentSearch: 'Introuvable' })).body.totalStudents).toBe(0);
    const spontaneousPage = await request().get(`${path}/spontaneous`).set(director).query({ ...base, page: 2, pageSize: 1 });
    expect(spontaneousPage.body.totalStudents).toBe(2);
    expect(spontaneousPage.body.students).toHaveLength(1);
    expect((await request().get(`${path}/spontaneous`).set(director).query({ ...base, teacherId: secondaryTeacher })).body.totalNotes).toBe(0);
    expect((await request().get(`${path}/spontaneous`).set(director).query({ ...base, gradingPeriodId: otherPeriod })).status).toBe(400);
    const futureSpontaneous = await request().get(`${path}/spontaneous`).set(director).query({ schoolYearId: futureYear, gradingPeriodId: futurePeriod });
    expect(futureSpontaneous.status).toBe(200);
    expect(futureSpontaneous.body.totalStudents).toBe(0);
    for (const filter of [{ levelId: level }, { classId }, { subjectId: subject }, { teacherId }]) {
      const response = await request().get(path).set(director).query({ ...base, ...filter });
      expect(response.status).toBe(200);
      expect(response.body.items.length).toBe(filter.subjectId ? 1 : 2);
    }
    const otherTeacherResult = await request().get(path).set(director).query({ ...base, teacherId: secondaryTeacher });
    expect(otherTeacherResult.body.items.map((item: { id: string }) => item.id)).toEqual([third]);
    const combined = await request().get(path).set(director).query({ ...base, levelId: level, classId, subjectId: subject, teacherId, page: 1, pageSize: 1 });
    expect(combined.body.total).toBe(1);
    expect(combined.body.items[0].id).toBe(first);
    const pageTwo = await request().get(path).set(director).query({ ...base, page: 2, pageSize: 1 });
    expect(pageTwo.body.total).toBe(3);
    expect(pageTwo.body.items).toHaveLength(1);
    expect((await request().get(path).set(director).query({ ...base, gradingPeriodId: otherPeriod })).status).toBe(400);
    const futureScheduled = await request().get(path).set(director).query({ schoolYearId: futureYear, gradingPeriodId: futurePeriod });
    expect(futureScheduled.status).toBe(200);
    expect(futureScheduled.body.total).toBe(0);
    expect((await request().get(path).set(director).query({ ...base, classId: otherClass })).status).toBe(400);
    const secondarySubject = await request().get(path).set(director).query({ ...base, subjectId: otherYearSubject });
    expect(secondarySubject.status).toBe(200);
    expect(secondarySubject.body.items.map((item: { id: string }) => item.id)).toEqual([third]);
    expect((await request().get(path).set(director).query({ ...base, levelId: otherLevel, classId })).status).toBe(400);
    expect((await request().get(path).set(director).query({ ...base, page: 0 })).status).toBe(400);
    expect((await request().get(path).set(director).query({ ...base, pageSize: 51 })).status).toBe(400);

    const foreignSchema = `school_c21_${randomBytes(3).toString('hex')}`;
    await createTenantSchema(foreignSchema);
    const foreignYear = (await queryPublic<{ id: string }>(`
      INSERT INTO "${foreignSchema}".school_years (label, start_date, end_date, end_of_year_review_start_date, status)
      VALUES ($1, '2023-09-01', '2024-06-30', '2024-05-31', 'draft') RETURNING id`, [`2023-${suffix}`]))[0]!.id;
    const foreignPeriod = (await queryPublic<{ id: string }>(`
      INSERT INTO "${foreignSchema}".grading_periods (school_year_id, type, order_index, label, start_date, end_date)
      VALUES ($1, 'trimester', 1, 'T1 étranger', '2023-09-01', '2023-12-20') RETURNING id`, [foreignYear]))[0]!.id;
    const ownOptions = await request().get(`${path}/options`).set(director);
    expect(ownOptions.body.schoolYears.some((item: { id: string }) => item.id === futureYear)).toBe(true);
    expect(ownOptions.body.schoolYears.some((item: { id: string }) => item.id === foreignYear)).toBe(false);
    expect((await request().get(path).set(director).query({ schoolYearId: foreignYear, gradingPeriodId: foreignPeriod })).status).toBe(400);
  });
});
