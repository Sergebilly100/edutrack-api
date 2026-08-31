import { describe, expect, it } from 'vitest';

import { withTenantSchema } from '../../src/shared/database/db.js';
import {
  FinancialAlertsRepository,
  FinancialAlertsService,
} from '../../src/modules/finance/financial-alerts.service.js';
import { getAuthHeaders, queryTenant, request, tenantTable, TEST_SCHEMA_NAME } from './setup.js';

const suffix = String(Date.now());

type IdRow = { id: string };

describe('financial alerts integration (6b)', () => {
  it('crée une notification in-app pour une règle in_app, mais pas pour une règle sms', async () => {
    const headers = await getAuthHeaders('director');

    // Année active + classe + deux élèves (un en retard, un à jour)
    await queryTenant(`UPDATE ${tenantTable('school_years')} SET status='closed' WHERE status='active'`);
    const years = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('school_years')} (label, start_date, end_date, end_of_year_review_start_date, status)
       VALUES ($1, '2099-09-01', '2100-06-30', '2100-05-01', 'active') RETURNING id::text`,
      [`fa-${suffix}`]
    );
    const yearId = years[0]!.id;
    const levels = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('levels')} (name, order_index, is_exam_class) VALUES ($1, 99800, false) RETURNING id::text`,
      [`FA level ${suffix}`]
    );
    const classes = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('classes')} (name, level_id, school_year_id, is_active)
       VALUES ($1, $2::uuid, $3::uuid, true) RETURNING id::text`,
      [`FA class ${suffix}`, levels[0]!.id, yearId]
    );
    const classId = classes[0]!.id;
    const students = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule, parent_phone)
       VALUES ($1::uuid, 'Late', 'Alerte', $2, '2250770000001'),
              ($1::uuid, 'Clean', 'Alerte', $3, '2250770000002')
       RETURNING id::text`,
      [classId, `FA-L-${suffix}`, `FA-C-${suffix}`]
    );
    const lateStudentId = students[0]!.id;
    const cleanStudentId = students[1]!.id;

    // Cache financier pré-rempli (responsabilité de la Tâche 6a)
    await queryTenant(
      `INSERT INTO ${tenantTable('student_financial_status')}
         (student_id, school_year_id, total_expected_to_date, total_paid, total_due_year, status, days_late, last_computed_at)
       VALUES ($1::uuid, $2::uuid, 100000, 20000, 300000, 'late', 12, NOW()),
              ($3::uuid, $2::uuid, 100000, 100000, 300000, 'up_to_date', NULL, NOW())`,
      [lateStudentId, yearId, cleanStudentId]
    );

    // Règle de retard : relance dès 3 jours de retard
    const upsert = await request()
      .put('/api/v1/financial-alert-rules/late')
      .set(headers)
      .send({ daysOffset: 3, channel: 'sms', isActive: true });
    expect(upsert.status, JSON.stringify(upsert.body)).toBe(200);

    // Exécution du lot quotidien avec fausse queue SMS
    const enqueued: Array<Record<string, unknown>> = [];
    const fakeSmsQueue = {
      add: async (_name: string, data: Record<string, unknown>) => {
        enqueued.push(data);
        return { id: 'fake' };
      },
    };

    const result = await withTenantSchema(TEST_SCHEMA_NAME, (tenantDb) =>
      new FinancialAlertsService(new FinancialAlertsRepository(tenantDb), fakeSmsQueue).runDailyOnDb(
        tenantDb,
        TEST_SCHEMA_NAME
      )
    );

    expect(result.sentCount).toBeGreaterThanOrEqual(1);

    // La relance du retardataire est loguée ; celle du bon élève est absente.
    const logs = await queryTenant<{ student_id: string; status: string }>(
      `SELECT l.student_id::text, l.status FROM ${tenantTable('financial_alert_logs')} l`
    );
    const lateLogs = logs.filter((log) => log.student_id === lateStudentId);
    const cleanLogs = logs.filter((log) => log.student_id === cleanStudentId);
    expect(lateLogs.length).toBeGreaterThanOrEqual(1);
    expect(cleanLogs).toHaveLength(0);

    // Un SMS a été mis en file via le contrat send-sms existant.
    expect(enqueued.length).toBeGreaterThanOrEqual(1);
    expect(enqueued[0]!['notificationType']).toBe('payment_reminder');

    // Le canal SMS seul ne crée pas de notification in-app.
    const smsOnlyNotifications = await queryTenant<{ id: string }>(
      `SELECT id::text
       FROM ${tenantTable('notifications_log')}
       WHERE type = 'payment_reminder'
         AND channel = 'in_app'
         AND related_id = $1::uuid`,
      [lateStudentId]
    );
    expect(smsOnlyNotifications).toHaveLength(0);

    // Une règle in_app, elle, alimente le journal visible par le directeur.
    const inAppUpsert = await request()
      .put('/api/v1/financial-alert-rules/severe_late')
      .set(headers)
      .send({ daysOffset: 10, channel: 'in_app', isActive: true });
    expect(inAppUpsert.status, JSON.stringify(inAppUpsert.body)).toBe(200);

    const inAppRun = await withTenantSchema(TEST_SCHEMA_NAME, (tenantDb) =>
      new FinancialAlertsService(new FinancialAlertsRepository(tenantDb), fakeSmsQueue).runDailyOnDb(
        tenantDb,
        TEST_SCHEMA_NAME
      )
    );
    expect(inAppRun.sentCount).toBeGreaterThanOrEqual(1);

    const inAppNotifications = await queryTenant<{
      channel: string;
      status: string;
      recipient_id: string | null;
      related_id: string;
    }>(
      `SELECT channel, status, recipient_id::text, related_id::text
       FROM ${tenantTable('notifications_log')}
       WHERE type = 'payment_reminder'
         AND channel = 'in_app'
         AND related_id = $1::uuid`,
      [lateStudentId]
    );
    expect(inAppNotifications).toHaveLength(1);
    expect(inAppNotifications[0]).toMatchObject({
      channel: 'in_app',
      status: 'delivered',
      related_id: lateStudentId,
    });
    expect(inAppNotifications[0]!.recipient_id).not.toBeNull();

    // Anti-doublon : rejouer immédiatement ne renvoie rien.
    const secondRun = await withTenantSchema(TEST_SCHEMA_NAME, (tenantDb) =>
      new FinancialAlertsService(new FinancialAlertsRepository(tenantDb), fakeSmsQueue).runDailyOnDb(
        tenantDb,
        TEST_SCHEMA_NAME
      )
    );
    expect(secondRun.skippedCount).toBeGreaterThanOrEqual(1);
  });

  it('CRUD des règles : consultation ouverte à payments.view', async () => {
    const headers = await getAuthHeaders('director');
    const list = await request().get('/api/v1/financial-alert-rules').set(headers);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.rules)).toBe(true);
  });

  it('pagine l’historique des relances sans plafonner les entrées anciennes', async () => {
    const headers = await getAuthHeaders('director');
    const firstPage = await request()
      .get('/api/v1/financial-alert-logs?page=1&limit=1')
      .set(headers);

    expect(firstPage.status, JSON.stringify(firstPage.body)).toBe(200);
    expect(firstPage.body.logs).toHaveLength(Math.min(1, firstPage.body.pagination.total));
    expect(firstPage.body.pagination).toMatchObject({ page: 1, limit: 1 });

    if (firstPage.body.pagination.total > 1) {
      const secondPage = await request()
        .get('/api/v1/financial-alert-logs?page=2&limit=1')
        .set(headers);
      expect(secondPage.status, JSON.stringify(secondPage.body)).toBe(200);
      expect(secondPage.body.pagination).toMatchObject({ page: 2, limit: 1 });
      expect(secondPage.body.logs).toHaveLength(1);
    }
  });
});
