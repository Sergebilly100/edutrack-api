import { describe, expect, it } from 'vitest';

import { getAuthHeaders, getSeedContext, queryTenant, request, tenantTable } from './setup.js';

const createAcademicContext = async (suffix: string) => {
  const years = await queryTenant<{ id: string; label: string }>(`
    INSERT INTO ${tenantTable('school_years')} (label, start_date, end_date, status)
    VALUES ('${suffix}-previous', '2080-09-01', '2081-06-30', 'draft'),
           ('${suffix}-target', '2081-09-01', '2082-06-30', 'draft')
    RETURNING id, label
  `);
  const previousYearId = years.find((row) => row.label === `${suffix}-previous`)?.id ?? years[0]!.id;
  const targetYearId = years.find((row) => row.label === `${suffix}-target`)?.id ?? years[1]!.id;
  const levels = await queryTenant<{ id: string }>(`
    INSERT INTO ${tenantTable('levels')} (name, order_index, is_exam_class)
    VALUES ('${suffix}-level-current', 80, false), ('${suffix}-level-target', 81, false)
    RETURNING id, name
  `);
  const currentLevelId = levels[0]!.id;
  const targetLevelId = levels[1]!.id;
  const currentClass = await queryTenant<{ id: string }>(`
    INSERT INTO ${tenantTable('classes')} (name, level_id, school_year_id, is_active)
    VALUES ('${suffix}-current-class', $1::uuid, $2::uuid, true) RETURNING id
  `, [currentLevelId, previousYearId]);
  const targetClass = await queryTenant<{ id: string }>(`
    INSERT INTO ${tenantTable('classes')} (name, level_id, school_year_id, is_active)
    VALUES ('${suffix}-target-class', $1::uuid, $2::uuid, true) RETURNING id
  `, [targetLevelId, targetYearId]);
  return { previousYearId, targetYearId, currentLevelId, targetLevelId, currentClassId: currentClass[0]!.id, targetClassId: targetClass[0]!.id };
};

describe('enrollments integration', () => {
  it('réalise une nouvelle inscription jusqu’à la confirmation caisse', async () => {
    const headers = await getAuthHeaders('director');
    const context = getSeedContext();
    const academic = await createAcademicContext('enrollment-new');
    const students = await queryTenant<{ id: string }>(`
      INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule)
      VALUES ($1::uuid, 'Aya', 'Yao', 'ENR-NEW-001') RETURNING id
    `, [academic.currentClassId]);
    const studentId = students[0]!.id;

    const tuitionPlan = await request()
      .put(`/api/v1/tuition-plans/classes/${academic.targetClassId}`)
      .set(headers)
      .send({ totalAmount: 120000, currency: 'FCFA', scheduleSteps: [] });
    expect(tuitionPlan.status).toBe(200);

    const documentType = await request().post('/api/v1/required-document-types').set(headers).send({
      levelId: academic.targetLevelId, name: 'Extrait de naissance', isMandatory: true,
    });
    expect(documentType.status).toBe(201);

    const creation = await request().post('/api/v1/enrollments').set(headers).send({
      studentId, classId: academic.targetClassId, schoolYearId: academic.targetYearId,
      type: 'new_registration',
    });
    expect(creation.status).toBe(201);
    expect(creation.body.enrollment.status).toBe('pending_cashier');
    expect(creation.body.missingMandatoryDocuments).toHaveLength(1);

    const provided = await request()
      .post(`/api/v1/students/${studentId}/enrollment-documents`)
      .set(headers)
      .send({ documentTypeId: documentType.body.documentType.id, status: 'provided', fileUrl: 'https://files.example.test/extrait.pdf' });
    expect(provided.status).toBe(201);

    const confirmation = await request()
      .post(`/api/v1/enrollments/${creation.body.enrollment.id}/confirm-payment`)
      .set(headers)
      .send({ method: 'cash' });
    expect(confirmation.status).toBe(200);
    expect(confirmation.body.enrollment).toMatchObject({ status: 'confirmed', confirmedByUserId: context.directorUserId });
    expect(confirmation.body.missingMandatoryDocuments).toHaveLength(0);
    expect(confirmation.body.payment).toMatchObject({ amount: 120000, source: 'cashier_manual' });
  });

  it('confirme une réinscription malgré un dossier incomplet', async () => {
    const headers = await getAuthHeaders('director');
    const academic = await createAcademicContext('enrollment-renew');
    const students = await queryTenant<{ id: string }>(`
      INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule, parent_phone)
      VALUES ($1::uuid, 'Mariam', 'Kouassi', 'ENR-RENEW-001', '2250700000009') RETURNING id
    `, [academic.currentClassId]);
    const studentId = students[0]!.id;
    const previousTuitionPlan = await request()
      .put(`/api/v1/tuition-plans/classes/${academic.currentClassId}`)
      .set(headers)
      .send({ totalAmount: 80000, currency: 'FCFA', scheduleSteps: [] });
    expect(previousTuitionPlan.status).toBe(200);
    const previousPayment = await request().post('/api/v1/payments').set(headers).send({
      studentId,
      schoolYearId: academic.previousYearId,
      amount: 80000,
      method: 'cash',
    });
    expect(previousPayment.status).toBe(201);
    const tuitionPlan = await request()
      .put(`/api/v1/tuition-plans/classes/${academic.targetClassId}`)
      .set(headers)
      .send({ totalAmount: 90000, currency: 'FCFA', scheduleSteps: [] });
    expect(tuitionPlan.status).toBe(200);
    await queryTenant(`
      INSERT INTO ${tenantTable('class_decisions')} (student_id, school_year_id, final_decision, next_level_id, validated_at)
      VALUES ($1::uuid, $2::uuid, 'promoted', $3::uuid, NOW())
    `, [studentId, academic.previousYearId, academic.targetLevelId]);
    await request().post('/api/v1/required-document-types').set(headers).send({
      levelId: academic.targetLevelId, name: 'Photo identité', isMandatory: true,
    });

    const creation = await request().post('/api/v1/enrollments').set(headers).send({
      studentId, classId: academic.targetClassId, schoolYearId: academic.targetYearId,
      type: 're_registration', hasPreviousYearUnpaid: false,
    });
    expect(creation.status).toBe(201);
    expect(creation.body.enrollment.status).toBe('pending_cashier');
    expect(creation.body.documentWarning).toContain('paiement reste autorisé');

    const verification = await request()
      .post(`/api/v1/students/${studentId}/enrollment-documents/verify`)
      .set(headers);
    expect(verification.status).toBe(200);
    expect(verification.body).toMatchObject({ dossierComplete: false, notificationQueued: true });
    expect(verification.body.missingMandatoryDocuments).toHaveLength(1);

    const confirmation = await request()
      .post(`/api/v1/enrollments/${creation.body.enrollment.id}/confirm-payment`)
      .set(headers)
      .send({ method: 'mobile_money', providerReference: 'MOMO-ENROLLMENT-001' });
    expect(confirmation.status).toBe(200);
    expect(confirmation.body.enrollment.status).toBe('confirmed');
    expect(confirmation.body.missingMandatoryDocuments).toHaveLength(1);
    expect(confirmation.body.documentWarning).toContain('Paiement confirmé');
  });

  it('calcule l’impayé antérieur côté serveur puis débloque après règlement', async () => {
    const headers = await getAuthHeaders('director');
    const academic = await createAcademicContext('enr-unpaid');
    const students = await queryTenant<{ id: string }>(`
      INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule)
      VALUES ($1::uuid, 'Jean', 'Nguessan', 'ENR-UNPAID-001') RETURNING id
    `, [academic.currentClassId]);
    const studentId = students[0]!.id;

    await request().put(`/api/v1/tuition-plans/classes/${academic.currentClassId}`).set(headers).send({
      totalAmount: 50000, currency: 'FCFA', scheduleSteps: [],
    });
    await request().put(`/api/v1/tuition-plans/classes/${academic.targetClassId}`).set(headers).send({
      totalAmount: 70000, currency: 'FCFA', scheduleSteps: [],
    });
    await queryTenant(`
      INSERT INTO ${tenantTable('class_decisions')}
        (student_id, school_year_id, final_decision, next_level_id, validated_at)
      VALUES ($1::uuid, $2::uuid, 'promoted', $3::uuid, NOW())
    `, [studentId, academic.previousYearId, academic.targetLevelId]);

    const creation = await request().post('/api/v1/enrollments').set(headers).send({
      studentId,
      classId: academic.targetClassId,
      schoolYearId: academic.targetYearId,
      type: 're_registration',
      hasPreviousYearUnpaid: false,
    });
    expect(creation.status).toBe(201);
    expect(creation.body.enrollment.status).toBe('blocked_unpaid');

    const settlement = await request().post('/api/v1/payments').set(headers).send({
      studentId,
      schoolYearId: academic.previousYearId,
      amount: 50000,
      method: 'cash',
    });
    expect(settlement.status).toBe(201);
    expect(settlement.body.financialStatus.remainingDue).toBe(0);

    const enrollment = await request()
      .get(`/api/v1/enrollments/${creation.body.enrollment.id}`)
      .set(headers);
    expect(enrollment.status).toBe(200);
    expect(enrollment.body.enrollment.status).toBe('pending_cashier');
  });
});
