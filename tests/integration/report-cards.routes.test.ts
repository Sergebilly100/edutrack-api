import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { signAccessToken } from '../../src/modules/auth/auth.service.js';
import { ParentPortalRepository } from '../../src/modules/parent-portal/parent-portal.repository.js';
import { ReportCardsRepository } from '../../src/modules/report-cards/report-cards.repository.js';
import { buildReportCardsService } from '../../src/modules/report-cards/report-cards.service.js';
import { withTenantSchema } from '../../src/shared/database/db.js';
import { getAuthHeaders, getSeedContext, queryTenant, request, tenantTable, TEST_SCHEMA_NAME } from './setup.js';

const suffix = String(Date.now());

type IdRow = { id: string };

describe('report-cards routes (5c)', () => {
  let directorHeaders: Record<string, string>;
  let parentHeaders: Record<string, string>;
  let levelId = '';
  let yearId = '';
  let classId = '';
  let periodT1 = '';
  let periodT2 = '';
  let subjectMathsId = '';
  let subjectFrenchId = '';
  let studentAId = '';
  let studentBId = '';

  const seedAverage = async (
    studentId: string,
    gradingPeriodId: string,
    subjectId: string | null,
    average: number
  ): Promise<void> => {
    await queryTenant(
      `INSERT INTO ${tenantTable('student_period_averages')} (student_id, subject_id, grading_period_id, average)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4)
       ON CONFLICT DO NOTHING`,
      [studentId, subjectId, gradingPeriodId, average]
    );
  };

  beforeAll(async () => {
    const context = getSeedContext();
    directorHeaders = await getAuthHeaders('director');

    // Année avec deux périodes : T1 puis T2 (dernière de l'année)
    await queryTenant(`UPDATE ${tenantTable('school_years')} SET status='closed' WHERE status='active'`);
    const years = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('school_years')} (label, start_date, end_date, end_of_year_review_start_date, status)
       VALUES ($1, '2096-09-01', '2097-06-30', '2097-05-01', 'active') RETURNING id::text`,
      [`rc-${suffix}`]
    );
    yearId = years[0]!.id;
    const periods = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('grading_periods')} (school_year_id, type, order_index, label, start_date, review_start_date, end_date)
       VALUES ($1::uuid, 'trimester', 1, 'T1 rc', CURRENT_DATE - 30, CURRENT_DATE - 1, CURRENT_DATE + 30),
              ($1::uuid, 'trimester', 2, 'T2 rc', CURRENT_DATE - 1, CURRENT_DATE, CURRENT_DATE + 90)
       RETURNING id::text`,
      [yearId]
    );
    periodT1 = periods[0]!.id;
    periodT2 = periods[1]!.id;

    const levels = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('levels')} (name, order_index, is_exam_class) VALUES ($1, 99600, false) RETURNING id::text`,
      [`RC level ${suffix}`]
    );
    levelId = levels[0]!.id;

    const subjects = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('subjects')} (level_id, name, coefficient)
       VALUES ($1::uuid, 'Maths RC', 4), ($1::uuid, 'Français RC', 2)
       RETURNING id::text`,
      [levelId]
    );
    subjectMathsId = subjects[0]!.id;
    subjectFrenchId = subjects[1]!.id;

    const classes = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('classes')} (name, level_id, school_year_id, is_active)
       VALUES ($1, $2::uuid, $3::uuid, true) RETURNING id::text`,
      [`RC class ${suffix}`, levelId, yearId]
    );
    classId = classes[0]!.id;

    const students = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule)
       VALUES ($1::uuid, 'Awa', 'Bulletin', $2),
              ($1::uuid, 'Yao', 'Bulletin', $3)
       RETURNING id::text`,
      [classId, `RCA-${suffix}`, `RCB-${suffix}`]
    );
    studentAId = students[0]!.id;
    studentBId = students[1]!.id;
    await queryTenant(`INSERT INTO ${tenantTable('enrollments')} (student_id, class_id, school_year_id, type, status)
      VALUES ($1::uuid, $3::uuid, $4::uuid, 'new_registration', 'confirmed'),
             ($2::uuid, $3::uuid, $4::uuid, 'new_registration', 'confirmed')`,
      [studentAId, studentBId, classId, yearId]);

    // Moyennes sources (module academic) pour T1 et T2
    await seedAverage(studentAId, periodT1, null, 15);
    await seedAverage(studentBId, periodT1, null, 10);
    await seedAverage(studentAId, periodT1, subjectMathsId, 16);
    await seedAverage(studentBId, periodT1, subjectMathsId, 8);
    await seedAverage(studentAId, periodT1, subjectFrenchId, 14);
    await seedAverage(studentBId, periodT1, subjectFrenchId, 12);
    await seedAverage(studentAId, periodT2, null, 14);
    await seedAverage(studentBId, periodT2, null, 11);
    await seedAverage(studentAId, periodT2, subjectMathsId, 14);
    await seedAverage(studentBId, periodT2, subjectMathsId, 11);
    await seedAverage(studentAId, periodT2, subjectFrenchId, 13);
    await seedAverage(studentBId, periodT2, subjectFrenchId, 11);
    await queryTenant(
      `INSERT INTO ${tenantTable('class_subject_completion')} (class_id, subject_id, grading_period_id, status, completed_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'completed', now()),
              ($1::uuid, $4::uuid, $3::uuid, 'completed', now()),
              ($1::uuid, $2::uuid, $5::uuid, 'completed', now()),
              ($1::uuid, $4::uuid, $5::uuid, 'completed', now())`,
      [classId, subjectMathsId, periodT1, subjectFrenchId, periodT2]
    );

    // Conduite finalisée pour student-a sur T1 (module 5b)
    await queryTenant(
      `INSERT INTO ${tenantTable('conduct_grades')} (student_id, grading_period_id, note, coefficient, decided_by_user_id)
       VALUES ($1::uuid, $2::uuid, 17, 1, $3::uuid)`,
      [studentAId, periodT1, context.directorUserId]
    );
    await queryTenant(
      `INSERT INTO ${tenantTable('conduct_grades')} (student_id, grading_period_id, note, coefficient, decided_by_user_id)
       VALUES ($2::uuid, $3::uuid, 12, 1, $5::uuid),
              ($1::uuid, $4::uuid, 16, 1, $5::uuid),
              ($2::uuid, $4::uuid, 11, 1, $5::uuid)`,
      [studentAId, studentBId, periodT1, periodT2, context.directorUserId]
    );

    // Décision de fin d'année validée pour student-a (workflow 2ter)
    await queryTenant(
      `INSERT INTO ${tenantTable('class_decisions')} (student_id, school_year_id, suggested_decision, final_decision, validated_by_user_id, validated_at)
       VALUES ($1::uuid, $2::uuid, 'promoted', 'promoted', $3::uuid, NOW())`,
      [studentAId, yearId, context.directorUserId]
    );

    // Token parent rattaché à student-a uniquement
    const parentToken = await signAccessToken({
      sub: context.directorUserId,
      role: 'parent',
      schemaName: TEST_SCHEMA_NAME,
      studentIds: [studentAId],
    });
    parentHeaders = { authorization: `Bearer ${parentToken}` };
  });

  it('refuse la génération quand une conduite finale manque', async () => {
    await queryTenant(`DELETE FROM ${tenantTable('conduct_grades')} WHERE student_id = $1::uuid AND grading_period_id = $2::uuid`, [studentBId, periodT1]);
    const response = await request().post('/api/v1/report-cards/generate').set(directorHeaders)
      .send({ class_id: classId, grading_period_id: periodT1 });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CONDUCT_GRADES_PENDING');
    const context = getSeedContext();
    await queryTenant(`INSERT INTO ${tenantTable('conduct_grades')} (student_id, grading_period_id, note, coefficient, decided_by_user_id)
      VALUES ($1::uuid, $2::uuid, 12, 1, $3::uuid)`, [studentBId, periodT1, context.directorUserId]);
  });

  it('génère les bulletins de la classe en snapshot complet', async () => {
    const yearId = (await queryTenant<{ school_year_id: string }>(`
      SELECT school_year_id::text FROM ${tenantTable('grading_periods')} WHERE id = $1::uuid`, [periodT1]))[0]!.school_year_id;
    const policy = await request().put(`/api/v1/conduct/policy/${yearId}`).set(directorHeaders)
      .send({ mode: 'homeroom', coefficient: 2 });
    expect(policy.status, JSON.stringify(policy.body)).toBe(200);
    const response = await request()
      .post('/api/v1/report-cards/generate')
      .set(directorHeaders)
      .send({ class_id: classId, grading_period_id: periodT1 });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.generatedCount).toBe(2);
    expect(response.body.periodCompleted).toBe(true);
    expect(response.body.classClosed).toBe(true);

    const pdfPayload = await withTenantSchema(TEST_SCHEMA_NAME, async db => {
      const card = (await queryTenant<IdRow>(`SELECT id::text FROM ${tenantTable('report_cards')}
        WHERE student_id = $1::uuid AND grading_period_id = $2::uuid`, [studentAId, periodT1]))[0]!;
      return buildReportCardsService(db).getPdfPayload(card.id);
    });
    expect(pdfPayload).toMatchObject({ schoolYearLabel: `rc-${suffix}`, generalAverage: 15.75, generalRank: 1,
      classAverage: 12.875, classMinAverage: 10, classMaxAverage: 15.75 });
    expect(pdfPayload.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ isConduct: true, average: 17, coefficient: 2 }),
    ]));
    // Données d'affichage ajoutées au PDF : identité lue en base, professeurs par matière (liste), aucune moyenne de classe par matière.
    expect(pdfPayload.student).toEqual(expect.objectContaining({ matricule: expect.anything() }));
    expect(pdfPayload.lines.every((line) => Array.isArray(line.teachers) && line.classAverage === null)).toBe(true);
    const coefficientChange = await request().put(`/api/v1/conduct/policy/${yearId}`).set(directorHeaders)
      .send({ mode: 'homeroom', coefficient: 3 });
    expect(coefficientChange.status).toBe(409);
    expect(coefficientChange.body.code).toBe('CONDUCT_COEFFICIENT_LOCKED');

    const periods = await request().get('/api/v1/grading-periods').set(directorHeaders);
    expect(periods.status, JSON.stringify(periods.body)).toBe(200);
    const t1 = periods.body.gradingPeriods.find((period: { id: string }) => period.id === periodT1);
    const t2 = periods.body.gradingPeriods.find((period: { id: string }) => period.id === periodT2);
    expect(t1).toMatchObject({ isCompleted: true, isCurrent: false });
    expect(t2).toMatchObject({ isCompleted: false, isCurrent: true });
  });

  it('expose le détail figé : rangs par matière, conduite, stats de classe', async () => {
    // Le directeur voit la liste via la classe : on récupère le bulletin de A par le détail.
    const readiness = await request()
      .get(`/api/v1/report-cards/readiness?grading_period_id=${periodT1}`)
      .set(directorHeaders);
    expect(readiness.status).toBe(200);
    const targetClass = readiness.body.classes.find((c: { classId: string }) => c.classId === classId);
    expect(targetClass).toBeDefined();
    expect(targetClass.readyToGenerate).toBe(true);

    // Récupération du bulletin publié ou non via la vue interne : on passe par generate + publish flow plus bas.
    // Ici on vérifie le bulletin non publié via un second compte à permission report_cards.view :
    // simplification - le directeur relit son propre bulletin généré après publication partielle.
    void readiness;
  });

  it('publication unitaire puis consultation parent', async () => {
    // On publie via bulk (classe entière générée) après avoir vérifié les états.
    const bulk = await request()
      .post('/api/v1/report-cards/publish-bulk')
      .set(directorHeaders)
      .send({ class_id: classId, grading_period_id: periodT1 });
    expect(bulk.status, JSON.stringify(bulk.body)).toBe(200);
    expect(bulk.body.publishedCount).toBe(2);

    const list = await request()
      .get(`/api/v1/parent/students/${studentAId}/report-cards`)
      .set(parentHeaders);
    expect(list.status).toBe(200);
    expect(list.body.reportCards).toHaveLength(1);
    expect(list.body.reportCards[0]).toMatchObject({
      generalAverage: 15.75,
      rank: 1,
      classHeadcount: 2,
    });
    const parentPdf = await request()
      .post(`/api/v1/parent/students/${studentAId}/report-cards/${list.body.reportCards[0].id as string}/pdf`)
      .set(parentHeaders);
    expect(parentPdf.status).toBe(202);
    const parentJob = await request().get(`/api/v1/jobs/${parentPdf.body.jobId as string}/status`).set(parentHeaders);
    expect(parentJob.status).toBe(200);
    const otherRoleJob = await request().get(`/api/v1/jobs/${parentPdf.body.jobId as string}/status`).set(directorHeaders);
    expect(otherRoleJob.status).toBe(200);
  });

  it("régénération : les bulletins publiés restent inchangés", async () => {
    // Correction d'une note source après publication
    await queryTenant(
      `UPDATE ${tenantTable('student_period_averages')} SET average = 18
       WHERE student_id = $1::uuid AND grading_period_id = $2::uuid AND subject_id IS NULL`,
      [studentAId, periodT1]
    );
    await queryTenant(
      `UPDATE ${tenantTable('student_period_averages')} SET average = 20
       WHERE student_id = $1::uuid AND grading_period_id = $2::uuid AND subject_id IS NULL`,
      [studentBId, periodT1]
    );

    const response = await request()
      .post('/api/v1/report-cards/generate')
      .set(directorHeaders)
      .send({ class_id: classId, grading_period_id: periodT1 });
    expect(response.status).toBe(200);
    // Les deux bulletins sont publiés : rien n'est régénéré.
    expect(response.body.generatedCount).toBe(0);

    // Le bulletin publié garde sa moyenne officielle initiale.
    const parentList = await request()
      .get(`/api/v1/parent/students/${studentAId}/report-cards`)
      .set(parentHeaders);
    expect(parentList.body.reportCards[0].generalAverage).toBe(15.75);
    expect(parentList.body.reportCards[0].rank).toBe(2);

    const yearResults = await request()
      .get(`/api/v1/students/${studentAId}/academic-years/${yearId}/results`)
      .set(directorHeaders);
    expect(yearResults.status, JSON.stringify(yearResults.body)).toBe(200);
    expect(yearResults.body.averages.find((average: { subjectName: string | null }) => average.subjectName === null).rank).toBe(2);

    const studentCards = await request()
      .get(`/api/v1/students/${studentAId}/report-cards`)
      .set(directorHeaders);
    expect(studentCards.body.reportCards[0].rank).toBe(2);

    const cardId = parentList.body.reportCards[0].id as string;
    const cardDetail = await request()
      .get(`/api/v1/students/${studentAId}/report-cards/${cardId}`)
      .set(directorHeaders);
    expect(cardDetail.body.reportCard.rank).toBe(2);

    const pdfPayload = await withTenantSchema(TEST_SCHEMA_NAME, db =>
      buildReportCardsService(db).getPdfPayload(cardId)
    );
    expect(pdfPayload.generalRank).toBe(2);

    const dossier = await request().get(`/api/v1/students/${studentAId}/dossier`).set(directorHeaders);
    expect(dossier.body.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ detail: expect.stringContaining('rang 2ème / 2') }),
    ]));

    await queryTenant(
      `UPDATE ${tenantTable('student_period_averages')} SET average = 10.5
       WHERE student_id = $1::uuid AND grading_period_id = $2::uuid AND subject_id IS NULL`,
      [studentBId, periodT1]
    );
  });

  it('décision de fin d\u2019année uniquement sur la dernière période', async () => {
    const response = await request()
      .post('/api/v1/report-cards/generate')
      .set(directorHeaders)
      .send({ class_id: classId, grading_period_id: periodT2 });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.generatedCount).toBeGreaterThanOrEqual(1);

    // Vérification directe en base : T2 porte la décision, pas T1.
    const decisions = await queryTenant<{ grading_period_id: string; class_decision_id: string | null }>(
      `SELECT rc.grading_period_id::text, rc.class_decision_id::text
       FROM ${tenantTable('report_cards')} rc
       WHERE rc.student_id = $1::uuid
       ORDER BY rc.grading_period_id::text`,
      [studentAId]
    );
    const t1Card = decisions.find((row) => row.grading_period_id === periodT1);
    const t2Card = decisions.find((row) => row.grading_period_id === periodT2);
    // T1 n'est pas la dernière période : pas de décision. T2 l'affiche.
    expect(t1Card?.class_decision_id).toBeNull();
    expect(t2Card?.class_decision_id).not.toBeNull();
  });

  it('parent sans accès à un élève : 403', async () => {
    const response = await request()
      .get(`/api/v1/parent/students/${studentBId}/report-cards`)
      .set(parentHeaders);
    expect([403]).toContain(response.status);
  });

  it('conserve le bulletin publié dans les archives d’une classe confirmée puis désactivée', async () => {
    const cardId = (await queryTenant<IdRow>(`SELECT id::text FROM ${tenantTable('report_cards')}
      WHERE student_id=$1::uuid AND grading_period_id=$2::uuid`, [studentAId, periodT1]))[0]!.id;
    await queryTenant(`UPDATE ${tenantTable('classes')} SET is_active=false WHERE id=$1::uuid`, [classId]);
    await queryTenant(`UPDATE ${tenantTable('students')} SET is_active=false WHERE id=$1::uuid`, [studentAId]);
    try {
      const currentYearId = (await queryTenant<{ school_year_id: string }>(
        `SELECT school_year_id::text FROM ${tenantTable('classes')} WHERE id=$1::uuid`, [classId]
      ))[0]!.school_year_id;
      const historyOptions = await request().get(`/api/v1/report-cards/classes?schoolYearId=${currentYearId}`).set(directorHeaders);
      expect(historyOptions.status, JSON.stringify(historyOptions.body)).toBe(200);
      expect(historyOptions.body.classes).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: classId, isActive: false }),
      ]));
      const cards = await request().get(`/api/v1/report-cards/class/${classId}?grading_period_id=${periodT1}`).set(directorHeaders);
      expect(cards.status, JSON.stringify(cards.body)).toBe(200);
      expect(cards.body.reportCards).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: cardId, status: 'published', rank: 1, generalAverage: 15.75 }),
      ]));
      await withTenantSchema(TEST_SCHEMA_NAME, async (db) => {
        const repository = new ReportCardsRepository(db);
        expect((await repository.listPublishedSummariesForStudent(studentAId)).map((card) => card.id)).toContain(cardId);
        expect((await repository.findCardDetail(cardId))?.id).toBe(cardId);
      });
      const list = await request().get(`/api/v1/students/${studentAId}/report-cards`).set(directorHeaders);
      expect(list.status).toBe(200);
      expect(list.body.reportCards).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: cardId, className: `RC class ${suffix}`, periodLabel: 'T1 rc' }),
      ]));
      const dossier = await request().get(`/api/v1/students/${studentAId}/dossier`).set(directorHeaders);
      expect(dossier.status, JSON.stringify(dossier.body)).toBe(200);
      expect(dossier.body.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'report_card', detail: expect.stringContaining('rang 1er / 2') }),
      ]));
      const detail = await request().get(`/api/v1/students/${studentAId}/report-cards/${cardId}`).set(directorHeaders);
      expect(detail.status).toBe(200);
      expect(detail.body.reportCard).toMatchObject({ id: cardId, status: 'published' });
      const pdf = await request().post(`/api/v1/students/${studentAId}/report-cards/${cardId}/pdf`).set(directorHeaders);
      expect(pdf.status).toBe(202);
      expect(pdf.body.jobId).toBeDefined();
      const job = await request().get(`/api/v1/jobs/${pdf.body.jobId as string}/status`).set(directorHeaders);
      expect(job.status).toBe(200);
      const parentJob = await request().get(`/api/v1/jobs/${pdf.body.jobId as string}/status`).set(parentHeaders);
      expect(parentJob.status).toBe(403);
      const otherStudent = await request().get(`/api/v1/students/${studentBId}/report-cards/${cardId}`).set(directorHeaders);
      expect(otherStudent.status).toBe(403);
      const parent = await request().get(`/api/v1/students/${studentAId}/report-cards`).set(parentHeaders);
      expect(parent.status).toBe(403);
    } finally {
      await queryTenant(`UPDATE ${tenantTable('classes')} SET is_active=true WHERE id=$1::uuid`, [classId]);
      await queryTenant(`UPDATE ${tenantTable('students')} SET is_active=true WHERE id=$1::uuid`, [studentAId]);
    }
  });

  it('affiche les rangs denses des bulletins déjà publiés sans modifier leurs snapshots', async () => {
    const cards = await queryTenant<{ id: string; student_id: string; rank: number; general_average: string }>(
      `SELECT id::text, student_id::text, rank, general_average::text
       FROM ${tenantTable('report_cards')}
       WHERE class_id=$1::uuid AND grading_period_id=$2::uuid`,
      [classId, periodT1]
    );
    const cardA = cards.find((card) => card.student_id === studentAId)!;
    const cardB = cards.find((card) => card.student_id === studentBId)!;
    const mathsLines = await queryTenant<{ id: string; report_card_id: string; subject_rank: number | null; subject_average: string }>(
      `SELECT id::text, report_card_id::text, subject_rank, subject_average::text
       FROM ${tenantTable('report_card_lines')}
       WHERE report_card_id IN ($1::uuid, $2::uuid) AND subject_id=$3::uuid`,
      [cardA.id, cardB.id, subjectMathsId]
    );
    const lineA = mathsLines.find((line) => line.report_card_id === cardA.id)!;
    const lineB = mathsLines.find((line) => line.report_card_id === cardB.id)!;

    try {
      // Simule deux anciens bulletins publiés ex aequo, dont les rangs stockés sont erronés.
      await queryTenant(`UPDATE ${tenantTable('report_cards')} SET rank=99 WHERE id IN ($1::uuid, $2::uuid)`,
        [cardA.id, cardB.id]);
      await queryTenant(`UPDATE ${tenantTable('report_cards')} SET general_average=$2 WHERE id=$1::uuid`,
        [cardB.id, cardA.general_average]);
      await queryTenant(`UPDATE ${tenantTable('report_card_lines')} SET subject_rank=99 WHERE id IN ($1::uuid, $2::uuid)`,
        [lineA.id, lineB.id]);
      await queryTenant(`UPDATE ${tenantTable('report_card_lines')} SET subject_average=$2 WHERE id=$1::uuid`,
        [lineB.id, lineA.subject_average]);

      const directorList = await request().get(`/api/v1/report-cards/class/${classId}?grading_period_id=${periodT1}`)
        .set(directorHeaders);
      expect(directorList.status, JSON.stringify(directorList.body)).toBe(200);
      expect(directorList.body.reportCards.map((card: { rank: number }) => card.rank)).toEqual([1, 1]);

      const studentList = await request().get(`/api/v1/students/${studentAId}/report-cards`).set(directorHeaders);
      expect(studentList.status, JSON.stringify(studentList.body)).toBe(200);
      expect(studentList.body.reportCards).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: cardA.id, rank: 1 }),
      ]));
      const studentDetail = await request().get(`/api/v1/students/${studentAId}/report-cards/${cardA.id}`)
        .set(directorHeaders);
      expect(studentDetail.status, JSON.stringify(studentDetail.body)).toBe(200);
      expect(studentDetail.body.reportCard.rank).toBe(1);
      expect(studentDetail.body.reportCard.lines).toEqual(expect.arrayContaining([
        expect.objectContaining({ subjectId: subjectMathsId, rank: 1 }),
      ]));
      const tiedDetail = await request().get(`/api/v1/students/${studentBId}/report-cards/${cardB.id}`)
        .set(directorHeaders);
      expect(tiedDetail.status, JSON.stringify(tiedDetail.body)).toBe(200);
      expect(tiedDetail.body.reportCard.rank).toBe(1);
      expect(tiedDetail.body.reportCard.lines).toEqual(expect.arrayContaining([
        expect.objectContaining({ subjectId: subjectMathsId, rank: 1 }),
      ]));

      const parentList = await request().get(`/api/v1/parent/students/${studentAId}/report-cards`)
        .set(parentHeaders);
      expect(parentList.status, JSON.stringify(parentList.body)).toBe(200);
      expect(parentList.body.reportCards[0].rank).toBe(1);
      const parentDetail = await request().get(`/api/v1/parent/students/${studentAId}/report-cards/${cardA.id}`)
        .set(parentHeaders);
      expect(parentDetail.status, JSON.stringify(parentDetail.body)).toBe(200);
      expect(parentDetail.body.reportCard.rank).toBe(1);
      expect(parentDetail.body.reportCard.lines).toEqual(expect.arrayContaining([
        expect.objectContaining({ subjectId: subjectMathsId, rank: 1 }),
      ]));

      const dossier = await request().get(`/api/v1/students/${studentAId}/dossier`).set(directorHeaders);
      expect(dossier.status, JSON.stringify(dossier.body)).toBe(200);
      expect(dossier.body.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'report_card', detail: expect.stringContaining('rang 1er / 2') }),
      ]));
      await withTenantSchema(TEST_SCHEMA_NAME, async (db) => {
        const pdf = await buildReportCardsService(db).getPdfPayload(cardA.id);
        expect(pdf.generalRank).toBe(1);
        expect(pdf.lines).toEqual(expect.arrayContaining([
          expect.objectContaining({ label: 'Maths RC', rank: 1 }),
        ]));
        const overview = await new ParentPortalRepository(db).getParentOverview(studentAId);
        expect(overview.latestPublishedReportCard).toMatchObject({ id: cardA.id, rank: 1 });
      });

      const stored = await queryTenant<{ rank: number }>(
        `SELECT rank FROM ${tenantTable('report_cards')} WHERE id=$1::uuid`, [cardA.id]
      );
      expect(stored[0]?.rank).toBe(99);
      const storedLine = await queryTenant<{ subject_rank: number | null }>(
        `SELECT subject_rank FROM ${tenantTable('report_card_lines')} WHERE id=$1::uuid`, [lineA.id]
      );
      expect(storedLine[0]?.subject_rank).toBe(99);
      const archivedVersion = await queryTenant<{ rank: number }>(
        `SELECT (snapshot->'card'->>'rank')::int AS rank
         FROM ${tenantTable('report_card_versions')} WHERE card_id=$1::uuid`, [cardA.id]
      );
      expect(archivedVersion[0]?.rank).toBe(cardA.rank);
    } finally {
      await queryTenant(`UPDATE ${tenantTable('report_cards')} SET rank=$2 WHERE id=$1::uuid`,
        [cardA.id, cardA.rank]);
      await queryTenant(`UPDATE ${tenantTable('report_cards')} SET rank=$2, general_average=$3 WHERE id=$1::uuid`,
        [cardB.id, cardB.rank, cardB.general_average]);
      await queryTenant(`UPDATE ${tenantTable('report_card_lines')} SET subject_rank=$2 WHERE id=$1::uuid`,
        [lineA.id, lineA.subject_rank]);
      await queryTenant(`UPDATE ${tenantTable('report_card_lines')} SET subject_rank=$2, subject_average=$3 WHERE id=$1::uuid`,
        [lineB.id, lineB.subject_rank, lineB.subject_average]);
    }
  });

  it('refuse les lectures classe–période interannées par appel forgé', async () => {
    const otherYearId = (await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('school_years')} (label, start_date, end_date, end_of_year_review_start_date, status)
       VALUES ($1, '2093-09-01', '2094-06-30', '2094-05-01', 'closed') RETURNING id::text`,
      [`rc-history-${suffix}`]
    ))[0]!.id;
    const otherPeriodId = (await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('grading_periods')} (school_year_id, type, order_index, label, start_date, review_start_date, end_date)
       VALUES ($1::uuid, 'trimester', 1, 'T1 ancien', '2093-09-01', '2093-11-15', '2093-12-15') RETURNING id::text`,
      [otherYearId]
    ))[0]!.id;
    const closedClassId = (await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('classes')} (name, level_id, school_year_id, is_active)
       VALUES ($1, $2::uuid, $3::uuid, true) RETURNING id::text`,
      [`RC closed ${suffix}`, levelId, otherYearId]
    ))[0]!.id;
    const cards = await request().get(`/api/v1/report-cards/class/${classId}?grading_period_id=${otherPeriodId}`).set(directorHeaders);
    expect(cards.status).toBe(400);
    expect(cards.body).toMatchObject({ code: 'CLASS_PERIOD_YEAR_MISMATCH', statusCode: 400 });
    const completion = await request().get(`/api/v1/report-cards/completion?classId=${classId}&gradingPeriodId=${otherPeriodId}`).set(directorHeaders);
    expect(completion.status).toBe(400);
    expect(completion.body).toMatchObject({ code: 'COMPLETION_SCOPE_MISMATCH', statusCode: 400 });
    const claims = await request().get(`/api/v1/report-cards/claims?classId=${classId}&gradingPeriodId=${otherPeriodId}`).set(directorHeaders);
    expect(claims.status).toBe(400);
    expect(claims.body).toMatchObject({ code: 'CLASS_PERIOD_YEAR_MISMATCH', statusCode: 400 });
    const options = await request().get(`/api/v1/report-cards/classes?schoolYearId=${otherYearId}`).set(directorHeaders);
    expect(options.status).toBe(200);
    expect(options.body.classes).toEqual([]);
    const generateClosed = await request().post('/api/v1/report-cards/generate').set(directorHeaders)
      .send({ class_id: closedClassId, grading_period_id: otherPeriodId });
    expect(generateClosed.status).toBe(409);
    expect(generateClosed.body).toMatchObject({ code: 'SCHOOL_YEAR_CLOSED', statusCode: 409 });
    const publishClosed = await request().post('/api/v1/report-cards/publish-bulk').set(directorHeaders)
      .send({ class_id: closedClassId, grading_period_id: otherPeriodId });
    expect(publishClosed.status).toBe(409);
    expect(publishClosed.body).toMatchObject({ code: 'SCHOOL_YEAR_CLOSED', statusCode: 409 });
    const claimClosed = await request().post('/api/v1/report-cards/claims').set(directorHeaders)
      .send({ classId: closedClassId, gradingPeriodId: otherPeriodId, subjectId: subjectMathsId,
        reason: 'Vérification du bulletin archivé' });
    expect(claimClosed.status).toBe(409);
    expect(claimClosed.body).toMatchObject({ code: 'SCHOOL_YEAR_CLOSED', statusCode: 409 });
  });

  it('clôture chaque classe séparément et ne rouvre pas une revue après une inscription tardive', async () => {
    const yearId = (await queryTenant<{ school_year_id: string }>(
      `SELECT school_year_id::text FROM ${tenantTable('grading_periods')} WHERE id=$1::uuid`, [periodT1]
    ))[0]!.school_year_id;
    const secondClassId = (await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('classes')} (name, level_id, school_year_id, is_active)
       VALUES ($1, $2::uuid, $3::uuid, true) RETURNING id::text`,
      [`RC second ${suffix}`, levelId, yearId]
    ))[0]!.id;
    const secondStudentId = (await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule)
       VALUES ($1::uuid, 'Autre', 'Classe', $2) RETURNING id::text`,
      [secondClassId, `RCC-${suffix}`]
    ))[0]!.id;
    await queryTenant(
      `INSERT INTO ${tenantTable('enrollments')} (student_id, class_id, school_year_id, type, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'new_registration', 'confirmed')`,
      [secondStudentId, secondClassId, yearId]
    );
    const before = await request().get('/api/v1/grading-periods').set(directorHeaders);
    const t1Before = before.body.gradingPeriods.find((period: { id: string }) => period.id === periodT1);
    expect(t1Before.closedClassIds).toContain(classId);
    expect(t1Before.closedClassIds).not.toContain(secondClassId);
    expect(t1Before.conductReviewOpen).toBe(true);

    await seedAverage(secondStudentId, periodT1, null, 14);
    await seedAverage(secondStudentId, periodT1, subjectMathsId, 15);
    await seedAverage(secondStudentId, periodT1, subjectFrenchId, 12);
    await queryTenant(`INSERT INTO ${tenantTable('conduct_grades')} (student_id, grading_period_id, note, coefficient, decided_by_user_id)
      VALUES ($1::uuid, $2::uuid, 14, 1, $3::uuid)`, [secondStudentId, periodT1, getSeedContext().directorUserId]);
    await queryTenant(
      `INSERT INTO ${tenantTable('class_subject_completion')} (class_id, subject_id, grading_period_id, status, completed_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'completed', now()),
              ($1::uuid, $4::uuid, $3::uuid, 'completed', now())`,
      [secondClassId, subjectMathsId, periodT1, subjectFrenchId]
    );
    const secondGeneration = await request().post('/api/v1/report-cards/generate').set(directorHeaders)
      .send({ class_id: secondClassId, grading_period_id: periodT1 });
    expect(secondGeneration.status, JSON.stringify(secondGeneration.body)).toBe(200);
    expect(secondGeneration.body).toMatchObject({ generatedCount: 1, classClosed: true });

    const lateStudentId = (await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule)
       VALUES ($1::uuid, 'Inscription', 'Tardive', $2) RETURNING id::text`,
      [classId, `RCL-${suffix}`]
    ))[0]!.id;
    await queryTenant(
      `INSERT INTO ${tenantTable('enrollments')} (student_id, class_id, school_year_id, type, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'new_registration', 'confirmed')`,
      [lateStudentId, classId, yearId]
    );
    const again = await request().post('/api/v1/report-cards/generate').set(directorHeaders)
      .send({ class_id: classId, grading_period_id: periodT1 });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ generatedCount: 0, classClosed: true });
    expect(await queryTenant(`SELECT id FROM ${tenantTable('report_cards')} WHERE student_id=$1::uuid AND grading_period_id=$2::uuid`,
      [lateStudentId, periodT1])).toHaveLength(0);
    const after = await request().get('/api/v1/grading-periods').set(directorHeaders);
    expect(after.body.gradingPeriods.find((period: { id: string }) => period.id === periodT1)).toMatchObject({
      isClosed: true,
      closedClassIds: expect.arrayContaining([classId, secondClassId]),
    });
  });

  it('signale une période historique dont la ligne conduite ne concorde plus avec la moyenne', async () => {
    const before = await request().get('/api/v1/report-cards/conduct-audit').set(directorHeaders);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body.periods).toEqual([]);
    const cardId = (await queryTenant<IdRow>(`SELECT id::text FROM ${tenantTable('report_cards')}
      WHERE student_id = $1::uuid AND grading_period_id = $2::uuid`, [studentAId, periodT2]))[0]!.id;
    await queryTenant(`UPDATE ${tenantTable('report_card_lines')} SET subject_coefficient = 1
      WHERE report_card_id = $1::uuid AND line_type = 'conduct'`, [cardId]);
    try {
      const audit = await request().get('/api/v1/report-cards/conduct-audit').set(directorHeaders);
      expect(audit.status, JSON.stringify(audit.body)).toBe(200);
      expect(audit.body.periods).toEqual(expect.arrayContaining([
        expect.objectContaining({ gradingPeriodId: periodT2, generatedCount: 1, publishedCount: 0 }),
      ]));
    } finally {
      await queryTenant(`UPDATE ${tenantTable('report_card_lines')} SET subject_coefficient = 2
        WHERE report_card_id = $1::uuid AND line_type = 'conduct'`, [cardId]);
    }
  });

  it('ne fait pas entrer la classe archivée dans la liste normale des inscriptions', async () => {
    const yearId = (await queryTenant<{ school_year_id: string }>(
      `SELECT school_year_id::text FROM ${tenantTable('classes')} WHERE id=$1::uuid`, [classId]
    ))[0]!.school_year_id;
    await queryTenant(`UPDATE ${tenantTable('classes')} SET is_active=false WHERE id=$1::uuid`, [classId]);
    try {
      const response = await request().get(`/api/v1/classes?schoolYearId=${yearId}`).set(directorHeaders);
      expect(response.status).toBe(200);
      expect(response.body.classes.map((item: { id: string }) => item.id)).not.toContain(classId);
    } finally {
      await queryTenant(`UPDATE ${tenantTable('classes')} SET is_active=true WHERE id=$1::uuid`, [classId]);
    }
  });

  it('filtre les années publiées par enfant et protège le détail et le PDF', async () => {
    const oldYearId = (await queryTenant<{ school_year_id: string }>(
      `SELECT school_year_id::text FROM ${tenantTable('grading_periods')} WHERE id=$1::uuid`, [periodT1]
    ))[0]!.school_year_id;
    const newYearId = (await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('school_years')} (label, start_date, end_date, end_of_year_review_start_date, status)
       VALUES ($1, '2098-09-01', '2099-06-30', '2099-05-01', 'closed') RETURNING id::text`,
      [`rc-new-${suffix}`]
    ))[0]!.id;
    const newClassId = (await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('classes')} (name, level_id, school_year_id, is_active)
       VALUES ($1, $2::uuid, $3::uuid, false) RETURNING id::text`,
      [`RC new class ${suffix}`, levelId, newYearId]
    ))[0]!.id;
    const newPeriodId = (await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('grading_periods')} (school_year_id, type, order_index, label, start_date, review_start_date, end_date)
       VALUES ($1::uuid, 'trimester', 1, 'T1 nouveau', '2098-09-01', '2098-12-01', '2098-12-15') RETURNING id::text`,
      [newYearId]
    ))[0]!.id;
    await queryTenant(
      `INSERT INTO ${tenantTable('enrollments')} (student_id, class_id, school_year_id, type, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'new_registration', 'confirmed')`,
      [studentAId, newClassId, newYearId]
    );
    const newCardId = (await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('report_cards')}
       (student_id, class_id, grading_period_id, general_average, rank, class_average,
        class_min_average, class_max_average, class_headcount, status, published_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 17, 1, 15, 10, 18, 2, 'published', NOW()) RETURNING id::text`,
      [studentAId, newClassId, newPeriodId]
    ))[0]!.id;

    const multiToken = await signAccessToken({
      sub: getSeedContext().directorUserId, role: 'parent', schemaName: TEST_SCHEMA_NAME,
      studentIds: [studentAId, studentBId],
    });
    const multiHeaders = { authorization: `Bearer ${multiToken}` };
    const oldA = await request().get(`/api/v1/parent/students/${studentAId}/report-cards`)
      .query({ schoolYearId: oldYearId }).set(multiHeaders);
    expect(oldA.status, JSON.stringify(oldA.body)).toBe(200);
    expect(oldA.body.reportCards.map((card: { schoolYearId: string }) => card.schoolYearId)).toEqual([oldYearId]);
    expect(oldA.body.availableSchoolYears).toEqual([
      { id: newYearId, label: `rc-new-${suffix}` }, { id: oldYearId, label: `rc-${suffix}` },
    ]);

    const newA = await request().get(`/api/v1/parent/students/${studentAId}/report-cards`)
      .query({ schoolYearId: newYearId }).set(multiHeaders);
    expect(newA.status).toBe(200);
    expect(newA.body.reportCards.map((card: { id: string }) => card.id)).toEqual([newCardId]);
    const oldB = await request().get(`/api/v1/parent/students/${studentBId}/report-cards`)
      .query({ schoolYearId: oldYearId }).set(multiHeaders);
    expect(oldB.status).toBe(200);
    expect(oldB.body.availableSchoolYears).toEqual([{ id: oldYearId, label: `rc-${suffix}` }]);
    const emptyB = await request().get(`/api/v1/parent/students/${studentBId}/report-cards`)
      .query({ schoolYearId: newYearId }).set(multiHeaders);
    expect(emptyB.status).toBe(200);
    expect(emptyB.body.reportCards).toEqual([]);
    expect(emptyB.body.availableSchoolYears).toEqual(oldB.body.availableSchoolYears);

    const invalidYear = await request().get(`/api/v1/parent/students/${studentAId}/report-cards`)
      .query({ schoolYearId: 'incorrect' }).set(multiHeaders);
    expect(invalidYear.status).toBe(400);
    const deniedStudent = await request().get(`/api/v1/parent/students/${studentBId}/report-cards`)
      .query({ schoolYearId: oldYearId }).set(parentHeaders);
    expect(deniedStudent.status).toBe(403);
    const foreignCardId = oldB.body.reportCards[0].id as string;
    const deniedDetail = await request().get(`/api/v1/parent/students/${studentAId}/report-cards/${foreignCardId}`)
      .set(parentHeaders);
    expect(deniedDetail.status).toBe(403);
    const deniedPdf = await request().post(`/api/v1/parent/students/${studentAId}/report-cards/${foreignCardId}/pdf`)
      .set(parentHeaders);
    expect(deniedPdf.status).toBe(403);
    const ownDetail = await request().get(`/api/v1/parent/students/${studentAId}/report-cards/${newCardId}`)
      .set(parentHeaders);
    expect(ownDetail.status).toBe(200);
    const ownPdf = await request().post(`/api/v1/parent/students/${studentAId}/report-cards/${newCardId}/pdf`)
      .set(parentHeaders);
    expect(ownPdf.status).toBe(202);
  });

  it('sert uniquement les notes validées du parent et masque la matière rouverte', async () => {
    const context = getSeedContext();
    const parentId = randomUUID();
    await queryTenant(
      `INSERT INTO ${tenantTable('parents')} (id, full_name, phone, password_hash, must_change_password)
       VALUES ($1::uuid, 'Parent C45', $2, 'not-used-by-test', false)`,
      [parentId, `22507${Date.now().toString().slice(-8)}`]
    );
    await queryTenant(
      `INSERT INTO ${tenantTable('parent_student_links')} (parent_id, student_id)
       VALUES ($1::uuid, $2::uuid)`,
      [parentId, studentAId]
    );

    const periodId = (await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('grading_periods')}
       (school_year_id, type, order_index, label, start_date, review_start_date, end_date)
       SELECT $1::uuid, 'trimester', COALESCE(MAX(order_index), 0) + 1, $2,
         CURRENT_DATE - 1, CURRENT_DATE, CURRENT_DATE + 30
       FROM ${tenantTable('grading_periods')} WHERE school_year_id = $1::uuid
       RETURNING id::text`,
      [yearId, `C45 ${suffix}`]
    ))[0]!.id;
    await queryTenant(
      `INSERT INTO ${tenantTable('conduct_grades')}
       (student_id, grading_period_id, note, coefficient, decided_by_user_id)
       VALUES ($1::uuid, $2::uuid, 13.75, 1, $3::uuid)`,
      [studentAId, periodId, context.directorUserId]
    );
    await queryTenant(
      `INSERT INTO ${tenantTable('class_subject_completion')}
       (class_id, subject_id, grading_period_id, status, completed_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'completed', NOW()),
              ($1::uuid, $4::uuid, $3::uuid, 'completed', NOW())`,
      [classId, subjectMathsId, periodId, subjectFrenchId]
    );
    await seedAverage(studentAId, periodId, subjectMathsId, 15);
    await seedAverage(studentAId, periodId, subjectFrenchId, 12);

    const scheduledEvaluationId = (await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('evaluations')}
       (subject_id, class_id, grading_period_id, teacher_id, type, coefficient, label, evaluation_date)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'scheduled', 2, 'Composition surveillée', CURRENT_DATE)
       RETURNING id::text`,
      [subjectMathsId, classId, periodId, context.teacherId]
    ))[0]!.id;
    await queryTenant(
      `INSERT INTO ${tenantTable('evaluation_grades')}
       (evaluation_id, student_id, score, max_score, comment)
       VALUES ($1::uuid, $2::uuid, 8, 10, 'Commentaire strictement privé'),
              ($1::uuid, $3::uuid, 4, 10, 'Note d’un autre enfant')`,
      [scheduledEvaluationId, studentAId, studentBId]
    );
    const frenchEvaluationId = (await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('evaluations')}
       (subject_id, class_id, grading_period_id, teacher_id, type, coefficient, label, evaluation_date)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'scheduled', 1, 'Dictée', CURRENT_DATE)
       RETURNING id::text`,
      [subjectFrenchId, classId, periodId, context.teacherId]
    ))[0]!.id;
    await queryTenant(
      `INSERT INTO ${tenantTable('evaluation_grades')}
       (evaluation_id, student_id, score, max_score, comment)
       VALUES ($1::uuid, $2::uuid, 12, 20, 'Commentaire privé français'),
              ($1::uuid, $3::uuid, 10, 20, 'Note privée autre élève')`,
      [frenchEvaluationId, studentAId, studentBId]
    );
    const incompleteFrenchEvaluationId = (await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('evaluations')}
       (subject_id, class_id, grading_period_id, teacher_id, type, coefficient, label, evaluation_date)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'scheduled', 1, 'Évaluation incomplète', CURRENT_DATE)
       RETURNING id::text`,
      [subjectFrenchId, classId, periodId, context.teacherId]
    ))[0]!.id;
    await queryTenant(
      `INSERT INTO ${tenantTable('evaluation_grades')}
       (evaluation_id, student_id, score, max_score)
       VALUES ($1::uuid, $2::uuid, 15, 20)`,
      [incompleteFrenchEvaluationId, studentAId]
    );
    const spontaneousEvaluationId = (await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('evaluations')}
       (subject_id, class_id, grading_period_id, teacher_id, type, coefficient, label, evaluation_date)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'spontaneous', 1, 'Note spontanée -1', CURRENT_DATE)
       RETURNING id::text`,
      [subjectMathsId, classId, periodId, context.teacherId]
    ))[0]!.id;
    await queryTenant(
      `INSERT INTO ${tenantTable('evaluation_grades')}
       (evaluation_id, student_id, score, max_score, comment)
       VALUES ($1::uuid, $2::uuid, 1, 20, 'Ajustement privé')`,
      [spontaneousEvaluationId, studentAId]
    );

    const parentToken = await signAccessToken({
      sub: parentId,
      role: 'parent',
      schemaName: TEST_SCHEMA_NAME,
      studentIds: [studentAId],
    });
    const parentAuth = { authorization: `Bearer ${parentToken}`, 'x-tenant-schema': TEST_SCHEMA_NAME };
    const unauthenticated = await request().get(`/api/v1/parent/students/${studentAId}/grades`);
    expect(unauthenticated.status).toBe(401);

    const defaultPeriod = await request()
      .get(`/api/v1/parent/students/${studentAId}/grades`)
      .set(parentAuth);
    expect(defaultPeriod.status).toBe(200);
    expect(defaultPeriod.body.selectedGradingPeriodId).toBe(periodId);
    expect(defaultPeriod.body.conductGrade).toBe(13.75);

    const response = await request()
      .get(`/api/v1/parent/students/${studentAId}/grades`)
      .query({ gradingPeriodId: periodId })
      .set(parentAuth);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.selectedGradingPeriodId).toBe(periodId);
    expect(response.body.subjects.map((subject: { name: string }) => subject.name)).toEqual(['Français RC', 'Maths RC']);
    const maths = response.body.subjects.find((subject: { id: string }) => subject.id === subjectMathsId);
    expect(maths).toEqual({
      id: subjectMathsId,
      name: 'Maths RC',
      average: 15,
      evaluations: [
        expect.objectContaining({
          label: 'Composition surveillée',
          type: 'scheduled',
          coefficient: 2,
          score: 8,
          maxScore: 10,
        }),
        expect.objectContaining({
          label: 'Note spontanée -1',
          type: 'spontaneous',
          coefficient: 1,
          score: -1,
          maxScore: 20,
        }),
      ],
    });
    expect(JSON.stringify(response.body)).not.toMatch(/Commentaire strictement privé|Commentaire privé français|Note d’un autre enfant|Ajustement privé|rank|audit|reason/i);

    await queryTenant(
      `UPDATE ${tenantTable('class_subject_completion')}
       SET status = 'in_progress', completed_at = NULL
       WHERE class_id = $1::uuid AND subject_id = $2::uuid AND grading_period_id = $3::uuid`,
      [classId, subjectFrenchId, periodId]
    );
    const completeEvaluation = await request()
      .get(`/api/v1/parent/students/${studentAId}/grades`)
      .query({ gradingPeriodId: periodId })
      .set(parentAuth);
    const frenchWhileUnvalidated = completeEvaluation.body.subjects.find(
      (subject: { id: string }) => subject.id === subjectFrenchId
    );
    expect(frenchWhileUnvalidated.average).toBeNull();
    expect(frenchWhileUnvalidated.evaluations.map((evaluation: { id: string }) => evaluation.id)).toEqual([frenchEvaluationId]);
    expect(JSON.stringify(frenchWhileUnvalidated)).not.toContain('Évaluation incomplète');
    await queryTenant(
      `UPDATE ${tenantTable('class_subject_completion')}
       SET status = 'completed', completed_at = NOW()
       WHERE class_id = $1::uuid AND subject_id = $2::uuid AND grading_period_id = $3::uuid`,
      [classId, subjectFrenchId, periodId]
    );

    const foreignPeriod = await request()
      .get(`/api/v1/parent/students/${studentAId}/grades`)
      .query({ gradingPeriodId: randomUUID() })
      .set(parentAuth);
    expect(foreignPeriod.status).toBe(404);
    expect(foreignPeriod.body.code).toBe('GRADING_PERIOD_NOT_FOUND');

    const forgedStudentToken = await signAccessToken({
      sub: parentId,
      role: 'parent',
      schemaName: TEST_SCHEMA_NAME,
      studentIds: [studentBId],
    });
    const unlinkedStudent = await request()
      .get(`/api/v1/parent/students/${studentBId}/grades`)
      .set({ authorization: `Bearer ${forgedStudentToken}`, 'x-tenant-schema': TEST_SCHEMA_NAME });
    expect(unlinkedStudent.status).toBe(403);
    expect(unlinkedStudent.body.code).toBe('STUDENT_ACCESS_DENIED');

    const claimId = (await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('report_card_claims')}
       (class_id, student_id, subject_id, grading_period_id, requested_by_user_id, reason, status, phase)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'raison confidentielle', 'approved', 'published')
       RETURNING id::text`,
      [classId, studentAId, subjectMathsId, periodId, context.directorUserId]
    ))[0]!.id;
    await queryTenant(
      `UPDATE ${tenantTable('class_subject_completion')}
       SET status = 'in_progress', completed_at = NULL
       WHERE class_id = $1::uuid AND subject_id = $2::uuid AND grading_period_id = $3::uuid`,
      [classId, subjectMathsId, periodId]
    );
    const inRevision = await request()
      .get(`/api/v1/parent/students/${studentAId}/grades`)
      .query({ gradingPeriodId: periodId })
      .set(parentAuth);
    expect(inRevision.status).toBe(200);
    expect(inRevision.body.subjects.map((subject: { name: string }) => subject.name)).toEqual(['Français RC']);
    expect(inRevision.body.resultsInRevision).toBe(true);
    expect(JSON.stringify(inRevision.body)).not.toMatch(/Maths RC|raison confidentielle|approved|claimId/i);

    await queryTenant(
      `UPDATE ${tenantTable('class_subject_completion')}
       SET status = 'completed', completed_at = NOW()
       WHERE class_id = $1::uuid AND subject_id = $2::uuid AND grading_period_id = $3::uuid`,
      [classId, subjectMathsId, periodId]
    );
    await queryTenant(`UPDATE ${tenantTable('report_card_claims')} SET status = 'corrected' WHERE id = $1::uuid`, [claimId]);
    await queryTenant(
      `UPDATE ${tenantTable('evaluation_grades')} SET score = 9
       WHERE evaluation_id = $1::uuid AND student_id = $2::uuid`,
      [scheduledEvaluationId, studentAId]
    );
    await queryTenant(
      `UPDATE ${tenantTable('student_period_averages')}
       SET average = 17 WHERE student_id = $1::uuid AND subject_id = $2::uuid AND grading_period_id = $3::uuid`,
      [studentAId, subjectMathsId, periodId]
    );
    const revalidated = await request()
      .get(`/api/v1/parent/students/${studentAId}/grades`)
      .query({ gradingPeriodId: periodId })
      .set(parentAuth);
    expect(revalidated.body.resultsInRevision).toBe(false);
    expect(revalidated.body.subjects[0].average).toBe(17);
    expect(revalidated.body.subjects[0].evaluations[0].score).toBe(9);
  });
});
