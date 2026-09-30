import { describe, expect, it } from 'vitest';

import { getAuthHeaders, getSeedContext, queryPublic, queryTenant, request, tenantTable, TEST_SCHEMA_NAME } from './setup.js';

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

const openReEnrollmentCycle = async (academic: Awaited<ReturnType<typeof createAcademicContext>>) => {
  await queryTenant(`UPDATE ${tenantTable('school_years')} SET status = 'closed' WHERE status = 'active' OR id = $1::uuid`, [academic.previousYearId]);
  await queryTenant(`UPDATE ${tenantTable('school_years')} SET status = 'active' WHERE id = $1::uuid`, [academic.targetYearId]);
};

describe('enrollments integration', () => {
  it('C12 : contexte serveur, droits et reprise seulement après configuration de la bonne année et du bon niveau', async () => {
    await queryPublic(`INSERT INTO public.tenants (name, subdomain, schema_name, plan, status, max_users, onboarding_completed)
      VALUES ('C12 test', $1, $2, 'pro', 'active', 50, true)
      ON CONFLICT (schema_name) DO NOTHING`, [TEST_SCHEMA_NAME.replaceAll('_', '-'), TEST_SCHEMA_NAME]);
    const director = await getAuthHeaders('director');
    const academic = await createAcademicContext('c12-recovery');
    const students = await queryTenant<{ id: string }>(`
      INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule)
      VALUES ($1::uuid, 'Test', 'C12', 'C12-001') RETURNING id
    `, [academic.currentClassId]);
    const created = await request().post('/api/v1/enrollments').set(director).send({
      studentId: students[0]!.id, classId: academic.targetClassId,
      schoolYearId: academic.targetYearId, type: 'new_registration',
    });
    expect(created.status).toBe(201);
    const enrollmentId = created.body.enrollment.id as string;
    const summaryPath = `/api/v1/enrollments/${enrollmentId}/payment-summary`;
    const missing = await request().get(summaryPath).set(director);
    const expectedError = { statusCode: 409, code: 'TUITION_PLAN_REQUIRED', context: {
      schoolYearId: academic.targetYearId, schoolYearLabel: 'c12-recovery-target',
      levelId: academic.targetLevelId, levelName: 'c12-recovery-level-target',
    } };
    expect(missing.status).toBe(409);
    expect(missing.body).toMatchObject(expectedError);
    const paymentBody = { amount: 25000, method: 'cash', schoolReceiptReference: 'C12-RECEIPT' };
    const unpaid = await request().post(`/api/v1/enrollments/${enrollmentId}/confirm-payment`).set(director).send(paymentBody);
    expect(unpaid.status).toBe(409);
    expect(unpaid.body).toMatchObject(expectedError);

    const position = await request().post('/api/v1/permissions/positions').set(director)
      .send({ name: 'Caisse C12', permissions: ['enrollments.confirm_payment'] });
    expect(position.status, JSON.stringify(position.body)).toBe(201);
    const positionId = position.body.position.id as string;
    const userId = getSeedContext().staffUserId;
    const assigned = await request().post(`/api/v1/permissions/positions/${positionId}/assign`).set(director).send({ userId });
    expect(assigned.status).toBe(200);
    const cashier = await getAuthHeaders('staff');
    try {
      expect((await request().get(summaryPath).set(cashier)).body).toMatchObject(expectedError);
      const planBody = { schoolYearId: academic.targetYearId, totalAmount: 120000, currency: 'FCFA', scheduleSteps: [] };
      const planPath = `/api/v1/tuition-plans/levels/${academic.targetLevelId}`;
      const forbidden = await request().put(planPath).set(cashier).send(planBody);
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.code).toBe('FORBIDDEN');
      const granted = await request().put(`/api/v1/permissions/positions/${positionId}`).set(director)
        .send({ permissions: ['enrollments.confirm_payment', 'tuition.edit'] });
      expect(granted.status).toBe(200);
      // Editing does not silently grant the unrelated read permissions.
      expect((await request().get(`/api/v1/tuition-plans?school_year_id=${academic.targetYearId}`).set(cashier)).status).toBe(403);
      for (const [levelId, schoolYearId] of [
        [academic.targetLevelId, academic.previousYearId],
        [academic.currentLevelId, academic.targetYearId],
      ]) {
        const otherPlan = await request().put(`/api/v1/tuition-plans/levels/${levelId}`).set(cashier).send({ ...planBody, schoolYearId });
        expect(otherPlan.status).toBe(200);
        expect((await request().get(summaryPath).set(cashier)).status).toBe(409);
        expect((await request().post(`/api/v1/enrollments/${enrollmentId}/confirm-payment`).set(cashier).send(paymentBody)).status).toBe(409);
      }
      const invalid = await request().put(planPath).set(cashier).send({ ...planBody, totalAmount: -1 });
      expect(invalid.status).toBe(400);
      expect((await request().get(summaryPath).set(cashier)).status).toBe(409);
      const saved = await request().put(planPath).set(cashier).send(planBody);
      expect(saved.status).toBe(200);
      expect(saved.body.tuitionPlan).toMatchObject({ school_year_id: academic.targetYearId, level_id: academic.targetLevelId });
      const ready = await request().get(summaryPath).set(cashier);
      expect(ready.status).toBe(200);
      expect(ready.body).toMatchObject({ enrollment: { id: enrollmentId, schoolYearId: academic.targetYearId }, amountDue: 120000 });
      const paid = await request().post(`/api/v1/enrollments/${enrollmentId}/confirm-payment`).set(cashier).send(paymentBody);
      expect(paid.status).toBe(200);
      expect(paid.body.enrollment.status).toBe('confirmed');
      expect((await request().get(summaryPath).set(cashier)).body.amountDue).toBe(95000);
    } finally {
      await request().delete(`/api/v1/permissions/positions/${positionId}/assign/${userId}`).set(director);
      await request().delete(`/api/v1/permissions/positions/${positionId}`).set(director);
    }
  });

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
      .put(`/api/v1/tuition-plans/levels/${academic.targetLevelId}`)
      .set(headers)
      .send({ schoolYearId: academic.targetYearId, totalAmount: 120000, currency: 'FCFA', scheduleSteps: [] });
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
    expect(creation.body.enrollment).toMatchObject({ studentFirstName: 'Aya', studentLastName: 'Yao' });
    expect(creation.body.enrollment).toMatchObject({ documentStatus: 'incomplete', missingMandatoryDocumentCount: 1 });
    expect(creation.body.missingMandatoryDocuments).toHaveLength(1);
    const beforePopulation = await request().get(`/api/v1/classes?schoolYearId=${academic.targetYearId}`).set(headers);
    expect(beforePopulation.status).toBe(200);
    expect(beforePopulation.body.classes.find((item: { id: string }) => item.id === academic.targetClassId)?.studentCount).toBe(0);
    const legacyPeriod = await queryTenant<{ id: string }>(`INSERT INTO ${tenantTable('grading_periods')}
      (school_year_id, type, order_index, label, start_date, end_date)
      VALUES ($1::uuid, 'trimester', 1, 'C24 pending snapshot', '2081-09-01', '2081-12-31') RETURNING id`,
      [academic.targetYearId]);
    await queryTenant(`INSERT INTO ${tenantTable('student_period_averages')}
      (student_id, grading_period_id, subject_id, average) VALUES ($1::uuid, $2::uuid, NULL, 18)`,
      [studentId, legacyPeriod[0]!.id]);
    await queryTenant(`INSERT INTO ${tenantTable('student_risk_status')} (student_id, grades_signal, risk_score, level)
      VALUES ($1::uuid, true, 1, 'attention')`, [studentId]);

    const enrollmentList = await request()
      .get(`/api/v1/enrollments?school_year_id=${academic.targetYearId}&level_id=${academic.targetLevelId}&class_id=${academic.targetClassId}&page=1&limit=10`)
      .set(headers);
    expect(enrollmentList.status).toBe(200);
    expect(enrollmentList.body.enrollments).toBeInstanceOf(Array);
    expect(enrollmentList.body.enrollments).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: creation.body.enrollment.id }),
    ]));
    expect(enrollmentList.body.pagination).toEqual(expect.objectContaining({
      page: 1,
      limit: 10,
      total: expect.any(Number),
      totalPages: expect.any(Number),
    }));

    const editableEnrollment = await request()
      .patch(`/api/v1/enrollments/${creation.body.enrollment.id}`)
      .set(headers)
      .send({ classId: academic.targetClassId });
    expect(editableEnrollment.status).toBe(200);

    const addedAfterEnrollment = await request().post('/api/v1/required-document-types/bulk').set(headers).send({
      levelIds: [academic.currentLevelId, academic.targetLevelId], name: 'Photo identité', isMandatory: true,
    });
    expect(addedAfterEnrollment.status).toBe(201);
    expect(addedAfterEnrollment.body.documentTypes).toHaveLength(2);
    const targetPhotoType = addedAfterEnrollment.body.documentTypes.find(
      (documentType: { level_id: string }) => documentType.level_id === academic.targetLevelId
    );
    expect(targetPhotoType).toBeDefined();

    const synchronizedDocuments = await request()
      .get(`/api/v1/students/${studentId}/enrollment-documents`)
      .set(headers);
    expect(synchronizedDocuments.status).toBe(200);
    expect(synchronizedDocuments.body.documents.map((document: { documentTypeName: string }) => document.documentTypeName)).toEqual([
      'Extrait de naissance', 'Photo identité',
    ]);

    const synchronizedRules = await request().put('/api/v1/required-document-types/bulk').set(headers).send({
      documentTypeIds: addedAfterEnrollment.body.documentTypes.map((item: { id: string }) => item.id),
      levelIds: [academic.targetLevelId],
      name: 'Photo officielle',
      isMandatory: false,
    });
    expect(synchronizedRules.status).toBe(200);
    expect(synchronizedRules.body.documentTypes).toHaveLength(1);
    expect(synchronizedRules.body.documentTypes[0]).toMatchObject({
      id: targetPhotoType.id, level_id: academic.targetLevelId, name: 'Photo officielle', is_mandatory: false,
    });

    const archived = await request()
      .delete(`/api/v1/required-document-types/${targetPhotoType.id}`)
      .set(headers);
    expect(archived.status).toBe(200);
    expect(archived.body).toEqual({ archived: true });

    const documentsAfterArchive = await request()
      .get(`/api/v1/students/${studentId}/enrollment-documents`)
      .set(headers);
    expect(documentsAfterArchive.body.documents).toHaveLength(1);
    const retainedRows = await queryTenant<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM ${tenantTable('student_documents')}
      WHERE student_id = $1::uuid AND document_type_id = $2::uuid
    `, [studentId, targetPhotoType.id]);
    expect(retainedRows[0]?.count).toBe('1');

    const provided = await request()
      .post(`/api/v1/students/${studentId}/enrollment-documents`)
      .set(headers)
      .send({ documentTypeId: documentType.body.documentType.id, status: 'provided', fileUrl: 'https://files.example.test/extrait.pdf' });
    expect(provided.status).toBe(201);

    const missingReceiptReference = await request()
      .post(`/api/v1/enrollments/${creation.body.enrollment.id}/confirm-payment`)
      .set(headers)
      .send({ amount: 30000, method: 'cash' });
    expect(missingReceiptReference.status).toBe(400);
    expect(missingReceiptReference.body.code).toBe('VALIDATION_ERROR');

    const excessivePayment = await request()
      .post(`/api/v1/enrollments/${creation.body.enrollment.id}/confirm-payment`)
      .set(headers)
      .send({ amount: 120001, method: 'cash', schoolReceiptReference: 'RC-OVER-001' });
    expect(excessivePayment.status).toBe(400);
    expect(excessivePayment.body.code).toBe('ENROLLMENT_PAYMENT_EXCEEDS_REMAINING_DUE');

    const confirmation = await request()
      .post(`/api/v1/enrollments/${creation.body.enrollment.id}/confirm-payment`)
      .set(headers)
      .send({ amount: 30000, method: 'cash', schoolReceiptReference: 'RC-ENROLL-001' });
    expect(confirmation.status).toBe(200);
    expect(confirmation.body.enrollment).toMatchObject({ status: 'confirmed', confirmedByUserId: context.directorUserId });
    expect(confirmation.body.missingMandatoryDocuments).toHaveLength(0);
    expect(confirmation.body.payment).toMatchObject({ amount: 30000, source: 'cashier_manual' });
    const afterPopulation = await request().get(`/api/v1/classes?schoolYearId=${academic.targetYearId}`).set(headers);
    expect(afterPopulation.status).toBe(200);
    expect(afterPopulation.body.classes.find((item: { id: string }) => item.id === academic.targetClassId)?.studentCount).toBe(1);
    expect(await queryTenant(`SELECT id FROM ${tenantTable('student_period_averages')} WHERE student_id=$1`, [studentId])).toHaveLength(0);
    expect(await queryTenant(`SELECT id FROM ${tenantTable('student_risk_status')} WHERE student_id=$1`, [studentId])).toHaveLength(0);
    const immutableEnrollment = await request()
      .patch(`/api/v1/enrollments/${creation.body.enrollment.id}`)
      .set(headers)
      .send({ classId: academic.targetClassId });
    expect(immutableEnrollment.status).toBe(409);
    expect(immutableEnrollment.body.code).toBe('CONFIRMED_ENROLLMENT_IMMUTABLE');
    const financialStatus = await request()
      .get(`/api/v1/students/${studentId}/financial-status?school_year_id=${academic.targetYearId}`)
      .set(headers);
    expect(financialStatus.body.financialStatus.remainingDue).toBe(90000);
    const cached = await queryTenant<{ total_paid: string }>(`
      SELECT total_paid::text FROM ${tenantTable('student_financial_status')}
      WHERE student_id = $1::uuid AND school_year_id = $2::uuid
    `, [studentId, academic.targetYearId]);
    expect(cached).toHaveLength(1);
    expect(Number(cached[0]!.total_paid)).toBe(30000);
  });

  it('confirme une réinscription malgré un dossier incomplet', async () => {
    const headers = await getAuthHeaders('director');
    const academic = await createAcademicContext('enrollment-renew');
    await openReEnrollmentCycle(academic);
    const students = await queryTenant<{ id: string }>(`
      INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule, parent_phone)
      VALUES ($1::uuid, 'Mariam', 'Kouassi', 'ENR-RENEW-001', '2250700000009') RETURNING id
    `, [academic.currentClassId]);
    const studentId = students[0]!.id;
    await queryTenant(`INSERT INTO ${tenantTable('enrollments')} (student_id, class_id, school_year_id, type, status)
      VALUES ($1, $2, $3, 'new_registration', 'confirmed')`, [studentId, academic.currentClassId, academic.previousYearId]);
    const previousTuitionPlan = await request()
      .put(`/api/v1/tuition-plans/levels/${academic.currentLevelId}`)
      .set(headers)
      .send({ schoolYearId: academic.previousYearId, totalAmount: 80000, currency: 'FCFA', scheduleSteps: [] });
    expect(previousTuitionPlan.status).toBe(200);
    const previousPayment = await request().post('/api/v1/payments').set(headers).send({
      studentId,
      schoolYearId: academic.previousYearId,
      amount: 80000,
      method: 'cash',
    });
    expect(previousPayment.status).toBe(201);
    const tuitionPlan = await request()
      .put(`/api/v1/tuition-plans/levels/${academic.targetLevelId}`)
      .set(headers)
      .send({ schoolYearId: academic.targetYearId, totalAmount: 90000, currency: 'FCFA', scheduleSteps: [] });
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

    const candidates = await request()
      .get(`/api/v1/enrollments/re-enrollment/candidates?school_year_id=${academic.targetYearId}&source_school_year_id=${academic.previousYearId}&level_id=${academic.currentLevelId}&class_id=${academic.currentClassId}`)
      .set(headers);
    expect(candidates.status).toBe(200);
    expect(candidates.body.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ studentId, enrollment: expect.objectContaining({ status: 'pending_cashier' }) }),
    ]));

    const summary = await request()
      .get(`/api/v1/enrollments/re-enrollment/students/${studentId}/summary`)
      .set(headers);
    expect(summary.status).toBe(200);
    expect(summary.body.years).toEqual(expect.arrayContaining([
      expect.objectContaining({ schoolYearId: academic.previousYearId, className: 'enrollment-renew-current-class' }),
      expect.objectContaining({ schoolYearId: academic.targetYearId, className: 'enrollment-renew-target-class' }),
    ]));

    const verification = await request()
      .post(`/api/v1/students/${studentId}/enrollment-documents/verify`)
      .set(headers);
    expect(verification.status).toBe(200);
    expect(verification.body).toMatchObject({ dossierComplete: false, notificationQueued: true });
    expect(verification.body.missingMandatoryDocuments).toHaveLength(1);

    const confirmation = await request()
      .post(`/api/v1/enrollments/${creation.body.enrollment.id}/confirm-payment`)
      .set(headers)
      .send({ amount: 30000, method: 'mobile_money', schoolReceiptReference: 'RC-ENROLL-002' });
    expect(confirmation.status).toBe(200);
    expect(confirmation.body.enrollment.status).toBe('confirmed');
    expect(confirmation.body.missingMandatoryDocuments).toHaveLength(1);
    expect(confirmation.body.documentWarning).toContain('Paiement confirmé');
    const movedStudent = await queryTenant<{ class_id: string }>(`
      SELECT class_id::text FROM ${tenantTable('students')} WHERE id = $1::uuid
    `, [studentId]);
    expect(movedStudent[0]?.class_id).toBe(academic.currentClassId);
    const enrolledProfile = await request().get(`/api/v1/students/${studentId}`).set(headers);
    expect(enrolledProfile.body.data.classId).toBe(academic.targetClassId);
  });

  it('calcule l’impayé antérieur côté serveur puis débloque après règlement', async () => {
    const headers = await getAuthHeaders('director');
    const academic = await createAcademicContext('enr-unpaid');
    await openReEnrollmentCycle(academic);
    const students = await queryTenant<{ id: string }>(`
      INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule)
      VALUES ($1::uuid, 'Jean', 'Nguessan', 'ENR-UNPAID-001') RETURNING id
    `, [academic.currentClassId]);
    const studentId = students[0]!.id;
    await queryTenant(`INSERT INTO ${tenantTable('enrollments')} (student_id, class_id, school_year_id, type, status)
      VALUES ($1, $2, $3, 'new_registration', 'confirmed')`, [studentId, academic.currentClassId, academic.previousYearId]);

    await request().put(`/api/v1/tuition-plans/levels/${academic.currentLevelId}`).set(headers).send({
      schoolYearId: academic.previousYearId, totalAmount: 50000, currency: 'FCFA', scheduleSteps: [],
    });
    await request().put(`/api/v1/tuition-plans/levels/${academic.targetLevelId}`).set(headers).send({
      schoolYearId: academic.targetYearId, totalAmount: 70000, currency: 'FCFA', scheduleSteps: [],
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

    await queryTenant(`WITH position AS (
      INSERT INTO admin_positions (name,permissions,created_by)
      VALUES ('Cashier blocked debt','["payments.record"]'::jsonb,$1::uuid) RETURNING id
    ) INSERT INTO position_assignments (user_id,position_id,assigned_by)
      SELECT $2::uuid,id,$1::uuid FROM position`, [getSeedContext().directorUserId, getSeedContext().staffUserId]);
    const cashier = await getAuthHeaders('staff');

    // Un élève bloqué doit rester trouvable par la saisie rapide afin que la
    // caisse puisse solder l’impayé, même s’il est déjà rattaché à la classe cible.
    await queryTenant(`UPDATE ${tenantTable('students')} SET class_id = $1::uuid WHERE id = $2::uuid`, [academic.targetClassId, studentId]);
    const cashierSearch = await request()
      .get('/api/v1/students/financial-profiles?search=Jean&limit=20')
      .set(headers);
    expect(cashierSearch.status).toBe(200);
    expect(cashierSearch.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: studentId }),
    ]));
    const currentYearCashierSearch = await request()
      .get(`/api/v1/students/cashier-candidates?search=ENR-UNPAID-001&school_year_id=${academic.targetYearId}`)
      .set(cashier);
    expect(currentYearCashierSearch.status, JSON.stringify(currentYearCashierSearch.body)).toBe(200);
    expect(currentYearCashierSearch.body.data).toEqual([expect.objectContaining({
      id: studentId,
      classId: academic.currentClassId,
      paymentSchoolYearId: academic.previousYearId,
      blockedReEnrollment: true,
    })]);
    expect(currentYearCashierSearch.body.data[0]).not.toHaveProperty('parentName');
    expect(currentYearCashierSearch.body.data[0]).not.toHaveProperty('note');
    const fullNameSearch = await request()
      .get(`/api/v1/students/cashier-candidates?search=Nguessan%20Jean&school_year_id=${academic.targetYearId}`)
      .set(cashier);
    expect(fullNameSearch.body.data).toEqual([expect.objectContaining({ id: studentId })]);
    const debtStatus = await request()
      .get(`/api/v1/students/${studentId}/financial-status?school_year_id=${academic.previousYearId}`)
      .set(cashier);
    expect(debtStatus.status).toBe(200);
    expect(debtStatus.body.financialStatus.remainingDue).toBe(50000);
    const settingsSearch = await request()
      .get(`/api/v1/students/financial-profiles?search=ENR-UNPAID-001&school_year_id=${academic.targetYearId}`)
      .set(headers);
    expect(settingsSearch.body.data).toEqual([]);
    const schoolRoster = await request().get('/api/v1/students?search=ENR-UNPAID-001').set(headers);
    expect(schoolRoster.body.data).toEqual([]);

    // Le scénario de règlement porte sur l'année close : on restaure donc le
    // rattachement d'origine après avoir vérifié la recherche de caisse.
    await queryTenant(`UPDATE ${tenantTable('students')} SET class_id = $1::uuid WHERE id = $2::uuid`, [academic.currentClassId, studentId]);

    const settlement = await request().post('/api/v1/payments').set(cashier).send({
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
    const afterSettlement = await request()
      .get(`/api/v1/students/cashier-candidates?search=ENR-UNPAID-001&school_year_id=${academic.targetYearId}`)
      .set(cashier);
    expect(afterSettlement.body.data).toEqual([]);
  });

  it('ne bloque pas une réinscription quand une remise couvre la dette antérieure', async () => {
    const headers = await getAuthHeaders('director');
    const academic = await createAcademicContext('enr-waived');
    await openReEnrollmentCycle(academic);
    const students = await queryTenant<{ id: string }>(`
      INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule)
      VALUES ($1::uuid, 'Aya', 'Remise', 'ENR-WAIVED-001') RETURNING id
    `, [academic.currentClassId]);
    const studentId = students[0]!.id;
    await queryTenant(`INSERT INTO ${tenantTable('enrollments')} (student_id, class_id, school_year_id, type, status)
      VALUES ($1, $2, $3, 'new_registration', 'confirmed')`, [studentId, academic.currentClassId, academic.previousYearId]);

    await request().put(`/api/v1/tuition-plans/levels/${academic.currentLevelId}`).set(headers).send({
      schoolYearId: academic.previousYearId, totalAmount: 50_000, currency: 'FCFA', scheduleSteps: [],
    });
    await request().put(`/api/v1/tuition-plans/levels/${academic.targetLevelId}`).set(headers).send({
      schoolYearId: academic.targetYearId, totalAmount: 70_000, currency: 'FCFA', scheduleSteps: [],
    });
    await queryTenant(`
      INSERT INTO ${tenantTable('class_decisions')}
        (student_id, school_year_id, final_decision, next_level_id, validated_at)
      VALUES ($1::uuid, $2::uuid, 'promoted', $3::uuid, NOW())
    `, [studentId, academic.previousYearId, academic.targetLevelId]);
    await queryTenant(`
      INSERT INTO ${tenantTable('payments')}
        (student_id, school_year_id, amount, method, source, status, payment_date, receipt_number)
      VALUES ($1::uuid, $2::uuid, 50000, 'cash', 'cashier_manual', 'waived_by_school', CURRENT_DATE, 'ENR-WAIVED-REC')
    `, [studentId, academic.previousYearId]);

    const financialStatus = await request()
      .get(`/api/v1/students/${studentId}/financial-status?school_year_id=${academic.previousYearId}`)
      .set(headers);
    expect(financialStatus.status).toBe(200);
    expect(financialStatus.body.financialStatus).toMatchObject({ remainingDue: 0, standing: 'up_to_date' });

    const creation = await request().post('/api/v1/enrollments').set(headers).send({
      studentId,
      classId: academic.targetClassId,
      schoolYearId: academic.targetYearId,
      type: 're_registration',
      hasPreviousYearUnpaid: true,
    });
    expect(creation.status).toBe(201);
    expect(creation.body.enrollment.status).toBe('pending_cashier');
  });
});
