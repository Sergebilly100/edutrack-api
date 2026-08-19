import { describe, expect, it } from 'vitest';
import argon2 from 'argon2';

import {
  getAuthHeaders,
  getSeedContext,
  queryPublic,
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
    .put(`/api/v1/tuition-plans/levels/${levels[0]!.id}`)
    .set(headers)
    .send({
      totalAmount,
      schoolYearId: years[0]!.id,
      currency: 'FCFA',
      scheduleSteps: [{ dueDate: isoDate(-1), cumulativeAmountExpected: 60_000 }],
    });
  expect(plan.status).toBe(200);
  return {
    headers,
    schoolYearId: years[0]!.id,
    classId: classes[0]!.id,
    levelId: levels[0]!.id,
    studentId: students[0]!.id,
  };
};

const createParentHeaders = async (studentId: string, suffix: string) => {
  const password = 'FinanceParent!2026';
  const phone = `22505${suffix.replace(/\D/g, '').slice(-8).padStart(8, '0')}`;
  const hash = await argon2.hash(password);
  await queryPublic(`
    INSERT INTO public.tenants (name, subdomain, schema_name, plan, status, max_users, onboarding_completed)
    VALUES ('Integration Finance School', $1, $2, 'pro', 'active', 50, true)
    ON CONFLICT (schema_name) DO UPDATE SET status = 'active', updated_at = NOW()
  `, [`integration-finance-${suffix}`, TEST_SCHEMA_NAME]);
  const parents = await queryTenant<{ id: string }>(`
    INSERT INTO ${tenantTable('parents')}
      (full_name, phone, password_hash, must_change_password, is_active)
    VALUES ('Parent Finance', $1, $2, false, true)
    RETURNING id::text
  `, [phone, hash]);
  await queryTenant(`
    INSERT INTO ${tenantTable('parent_student_links')} (subscription_id, parent_id, student_id)
    VALUES (NULL, $1::uuid, $2::uuid)
  `, [parents[0]!.id, studentId]);
  const login = await request()
    .post('/api/v1/auth/login/parent')
    .set('x-tenant-schema', TEST_SCHEMA_NAME)
    .send({ phone, password });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  return { authorization: `Bearer ${login.body.accessToken as string}` };
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
    const columns = await queryTenant<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'tuition_plans'
      ORDER BY column_name
    `);
    expect(columns.map((column) => column.column_name)).toEqual(expect.arrayContaining(['level_id', 'school_year_id']));
    expect(columns.map((column) => column.column_name)).not.toContain('class_id');
  });

  it('applique un même plan à toutes les classes du niveau pour une année scolaire', async () => {
    const context = await createFinanceContext(`shared-level-${Date.now()}`);
    const secondClass = await queryTenant<{ id: string }>(`
      INSERT INTO ${tenantTable('classes')} (name, level_id, school_year_id, is_active)
      VALUES ('finance-class-sibling', $1::uuid, $2::uuid, true)
      RETURNING id::text
    `, [context.levelId, context.schoolYearId]);
    const secondStudent = await queryTenant<{ id: string }>(`
      INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule)
      VALUES ($1::uuid, 'Koffi', 'Même Niveau', $2)
      RETURNING id::text
    `, [secondClass[0]!.id, `LEVEL-${Date.now()}`]);

    const status = await request()
      .get(`/api/v1/students/${secondStudent[0]!.id}/financial-status?school_year_id=${context.schoolYearId}`)
      .set(context.headers);
    expect(status.status, JSON.stringify(status.body)).toBe(200);
    expect(status.body.financialStatus.totalDue).toBe(100_000);

    const plans = await request()
      .get(`/api/v1/tuition-plans?school_year_id=${context.schoolYearId}`)
      .set(context.headers);
    expect(plans.status).toBe(200);
    expect(plans.body.tuitionPlans).toEqual([
      expect.objectContaining({ level_id: context.levelId, school_year_id: context.schoolYearId }),
    ]);
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

    const history = await request()
      .get(`/api/v1/students/${context.studentId}/payments?school_year_id=${context.schoolYearId}`)
      .set(context.headers);
    expect(history.status, JSON.stringify(history.body)).toBe(200);
    expect(history.body.payments).toHaveLength(1);
    expect(history.body.payments[0]).toMatchObject({ id: response.body.payment.id, amount: 100_000 });
  });

  it('isole le dossier financier parent et maintient le paiement direct désactivé', async () => {
    const suffix = String(Date.now());
    const linked = await createFinanceContext(`parent-linked-${suffix}`);
    const other = await createFinanceContext(`parent-other-${suffix}`);
    const recorded = await request().post('/api/v1/payments').set(linked.headers).send({
      studentId: linked.studentId,
      schoolYearId: linked.schoolYearId,
      amount: 30_000,
      method: 'cash',
    });
    expect(recorded.status).toBe(201);

    const provider = await request().put('/api/v1/payment-provider-settings').set(linked.headers).send({
      provider: 'orange_money',
      merchantNumber: '0700000000',
      apiCredentials: { token: 'integration-secret' },
      isActive: true,
    });
    expect(provider.status, JSON.stringify(provider.body)).toBe(200);
    expect(provider.body.setting.is_active).toBe(false);
    const preserved = await request().put('/api/v1/payment-provider-settings').set(linked.headers).send({
      provider: 'orange_money',
      merchantNumber: '0700000000',
      apiCredentials: {},
      isActive: true,
    });
    expect(preserved.status).toBe(200);
    expect(preserved.body.setting).toMatchObject({ is_active: false, has_credentials: true });

    const parentHeaders = await createParentHeaders(linked.studentId, suffix);
    const status = await request()
      .get(`/api/v1/parent/students/${linked.studentId}/financial-status?school_year_id=${linked.schoolYearId}`)
      .set(parentHeaders);
    expect(status.status).toBe(200);
    expect(status.body.financialStatus).toMatchObject({ confirmedPaid: 30_000, remainingDue: 70_000 });

    const history = await request()
      .get(`/api/v1/parent/students/${linked.studentId}/payments?school_year_id=${linked.schoolYearId}`)
      .set(parentHeaders);
    expect(history.status).toBe(200);
    expect(history.body.payments).toHaveLength(1);

    const forbidden = await request()
      .get(`/api/v1/parent/students/${other.studentId}/payments?school_year_id=${other.schoolYearId}`)
      .set(parentHeaders);
    expect(forbidden.status).toBe(403);

    const receipt = await request()
      .post(`/api/v1/parent/students/${linked.studentId}/payments/${recorded.body.payment.id}/receipt`)
      .set(parentHeaders);
    expect(receipt.status).toBe(202);
    expect(receipt.body.jobId).toBeTruthy();

    const options = await request().get('/api/v1/parent/payment-options').set(parentHeaders);
    expect(options.status).toBe(200);
    expect(options.body).toMatchObject({
      inAppPaymentActive: false,
      disabledReason: 'temporarily_disabled',
      manualPaymentChannels: [{ provider: 'orange_money', merchant_number: '0700000000' }],
    });
    expect(JSON.stringify(options.body)).not.toContain('integration-secret');
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

  it('génère le journal filtré et l’état de compte avec solde progressif', async () => {
    const context = await createFinanceContext(`journal-${Date.now()}`);
    for (const [amount, method] of [[20_000, 'cash'], [15_000, 'mobile_money']] as const) {
      const response = await request().post('/api/v1/payments').set(context.headers).send({
        studentId: context.studentId, schoolYearId: context.schoolYearId, amount, method,
      });
      expect(response.status).toBe(201);
    }
    const today = isoDate(0);
    const journal = await request()
      .get(`/api/v1/payments/cash-journal?school_year_id=${context.schoolYearId}&class_id=${context.classId}&from=${today}&to=${today}`)
      .set(context.headers);
    expect(journal.status, JSON.stringify(journal.body)).toBe(200);
    expect(journal.body.journal.totals).toMatchObject({ cash: 20_000, mobile_money: 15_000, grandTotal: 35_000 });
    expect(journal.body.journal.entries).toHaveLength(2);

    const excel = await request()
      .get(`/api/v1/payments/cash-journal/export?format=xlsx&school_year_id=${context.schoolYearId}&from=${today}&to=${today}`)
      .set(context.headers);
    expect(excel.status).toBe(200);
    expect(excel.headers['content-type']).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    const pdf = await request()
      .get(`/api/v1/payments/cash-journal/export?format=pdf&school_year_id=${context.schoolYearId}&from=${today}&to=${today}`)
      .set(context.headers);
    expect(pdf.status).toBe(202);
    expect(pdf.body.jobId).toBeTruthy();

    const statement = await request()
      .get(`/api/v1/students/${context.studentId}/account-statement?school_year_id=${context.schoolYearId}`)
      .set(context.headers);
    expect(statement.status, JSON.stringify(statement.body)).toBe(200);
    expect(statement.body.statement.movements.map((item: { balanceAfter: number }) => item.balanceAfter)).toEqual([80_000, 65_000]);
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
