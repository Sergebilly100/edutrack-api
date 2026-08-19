import { describe, expect, it } from 'vitest';

import {
  getAuthHeaders,
  getSeedContext,
  queryTenant,
  request,
  tenantTable,
  TEST_SCHEMA_NAME,
} from './setup.js';

const isoDate = (offsetDays: number): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
};

const createFinanceContext = async (suffix: string, totalAmount = 100_000) => {
  const shortSuffix = suffix.slice(-15);
  const years = await queryTenant<{ id: string }>(`
    INSERT INTO ${tenantTable('school_years')}
      (label, start_date, end_date, end_of_year_review_start_date, status)
    VALUES ($1, '2084-09-01', '2085-06-30', '2085-05-01', 'draft')
    RETURNING id
  `, [`fin-${shortSuffix}`]);
  const levels = await queryTenant<{ id: string }>(`
    INSERT INTO ${tenantTable('levels')} (name, order_index, is_exam_class)
    VALUES ($1, $2, false) RETURNING id
  `, [`finance-level-${suffix}`, 200 + Math.floor(Math.random() * 10_000)]);
  const classes = await queryTenant<{ id: string }>(`
    INSERT INTO ${tenantTable('classes')} (name, level_id, school_year_id, is_active)
    VALUES ($1, $2::uuid, $3::uuid, true) RETURNING id
  `, [`finance-class-${suffix}`, levels[0]!.id, years[0]!.id]);
  const students = await queryTenant<{ id: string }>(`
    INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule)
    VALUES ($1::uuid, 'Awa', 'Finance', $2) RETURNING id
  `, [classes[0]!.id, `FIN-${suffix}`]);

  const headers = await getAuthHeaders('director');
  const plan = await request()
    .put(`/api/v1/tuition-plans/classes/${classes[0]!.id}`)
    .set(headers)
    .send({
      totalAmount,
      currency: 'FCFA',
      scheduleSteps: [{ dueDate: isoDate(-1), cumulativeAmountExpected: 60_000 }],
    });
  expect(plan.status).toBe(200);
  return {
    headers,
    schoolYearId: years[0]!.id,
    classId: classes[0]!.id,
    studentId: students[0]!.id,
  };
};

describe('finance routes integration', () => {
  it('rejoue la migration financière de façon idempotente', async () => {
    const { createTenantSchema } = await import('../../src/shared/database/tenant-init.js');
    await createTenantSchema(TEST_SCHEMA_NAME);
    const tables = await queryTenant<{ count: number }>(`
      SELECT COUNT(*)::int AS count
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name IN (
          'tuition_plans', 'tuition_schedule_steps', 'student_tuition_overrides',
          'payment_provider_settings', 'payments', 'subscription_plans'
        )
    `);
    expect(tables[0]!.count).toBe(6);
  });

  it('enregistre le paiement complet du montant dû et prépare le reçu', async () => {
    const context = await createFinanceContext(`full-${Date.now()}`);
    const response = await request().post('/api/v1/payments').set(context.headers).send({
      studentId: context.studentId,
      schoolYearId: context.schoolYearId,
      amount: 100_000,
      method: 'cash',
      schoolReceiptReference: 'CARNET-42',
    });

    expect(response.status).toBe(201);
    expect(response.body.payment).toMatchObject({
      amount: 100_000,
      source: 'cashier_manual',
      status: 'confirmed',
      schoolReceiptReference: 'CARNET-42',
    });
    expect(response.body.financialStatus).toMatchObject({
      confirmedPaid: 100_000,
      remainingDue: 0,
      standing: 'up_to_date',
    });
    expect(response.body.receiptJobId).toBeTruthy();
  });

  it('classe un paiement partiel sous le seuil cumulé comme en retard', async () => {
    const context = await createFinanceContext(`partial-${Date.now()}`);
    const response = await request().post('/api/v1/payments').set(context.headers).send({
      studentId: context.studentId,
      schoolYearId: context.schoolYearId,
      amount: 20_000,
      method: 'bank_transfer',
    });

    expect(response.status).toBe(201);
    expect(response.body.financialStatus).toMatchObject({
      confirmedPaid: 20_000,
      cumulativeExpectedAtDate: 60_000,
      standing: 'late',
    });
  });

  it('refuse une annulation sans justification puis conserve la trace complète', async () => {
    const context = await createFinanceContext(`cancel-${Date.now()}`);
    const recorded = await request().post('/api/v1/payments').set(context.headers).send({
      studentId: context.studentId,
      schoolYearId: context.schoolYearId,
      amount: 25_000,
      method: 'mobile_money',
      providerReference: 'MM-CANCEL-01',
    });
    expect(recorded.status).toBe(201);

    const invalid = await request()
      .post(`/api/v1/payments/${recorded.body.payment.id}/cancel`)
      .set(context.headers)
      .send({ reason: '   ' });
    expect(invalid.status).toBe(400);

    const cancelled = await request()
      .post(`/api/v1/payments/${recorded.body.payment.id}/cancel`)
      .set(context.headers)
      .send({ reason: 'Référence attribuée au mauvais élève' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.payment).toMatchObject({
      status: 'cancelled',
      cancellationReason: 'Référence attribuée au mauvais élève',
      cancelledByUserId: getSeedContext().directorUserId,
    });
    expect(cancelled.body.payment.cancelledAt).toBeTruthy();
  });

  it('accorde une remise et notifie systématiquement le responsable', async () => {
    const context = await createFinanceContext(`discount-${Date.now()}`);
    const response = await request().post('/api/v1/tuition/overrides').set(context.headers).send({
      studentId: context.studentId,
      schoolYearId: context.schoolYearId,
      discountAmount: 15_000,
      reason: 'Soutien exceptionnel validé',
    });
    expect(response.status).toBe(201);

    const notifications = await queryTenant<{ related_id: string; metadata: { event?: string } }>(`
      SELECT related_id::text, metadata
      FROM ${tenantTable('notifications_log')}
      WHERE related_id = $1::uuid AND type = 'custom'
    `, [response.body.override.id]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.metadata.event).toBe('tuition_discount_granted');
  });
});
