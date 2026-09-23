import argon2 from 'argon2';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { withTenantSchema } from '../../src/shared/database/db.js';
import { FinancialAlertsRepository, FinancialAlertsService } from '../../src/modules/finance/financial-alerts.service.js';
import { getAuthHeaders, getSeedContext, queryPublic, queryTenant, request, TEST_SCHEMA_NAME } from './setup.js';

const run = (queue?: { add: ReturnType<typeof vi.fn> }) => withTenantSchema(TEST_SCHEMA_NAME, (db) =>
  new FinancialAlertsService(new FinancialAlertsRepository(db), queue).runDailyOnDb(db, TEST_SCHEMA_NAME));

describe('F21 — livraison des relances dans la boîte des parents', () => {
  let yearId: string;
  let studentId: string;
  let parentId: string;
  let parentHeaders: Record<string, string>;
  let otherHeaders: Record<string, string>;

  beforeAll(async () => {
    const seed = getSeedContext();
    await queryPublic("INSERT INTO public.tenants (name, subdomain, schema_name, plan, status, max_users, onboarding_completed) VALUES ('QA relances', $1, $2, 'pro', 'active', 50, true)", [TEST_SCHEMA_NAME.replaceAll('_', '-'), TEST_SCHEMA_NAME]);
    await queryTenant("UPDATE school_years SET status='closed' WHERE status='active'");
    const [year] = await queryTenant<{ id: string }>(
      "INSERT INTO school_years (label, start_date, end_date, end_of_year_review_start_date, status) VALUES ('QA relances', CURRENT_DATE-30, CURRENT_DATE+300, CURRENT_DATE+270, 'active') RETURNING id");
    yearId = year!.id;
    const [level] = await queryTenant<{ id: string }>("INSERT INTO levels(name, order_index) VALUES ('QA relances', 890) RETURNING id");
    const [klass] = await queryTenant<{ id: string }>(
      "UPDATE classes SET school_year_id=$1, level_id=$2 WHERE name=$3 RETURNING id", [yearId, level!.id, seed.className]);
    const [student] = await queryTenant<{ id: string }>(
      "INSERT INTO students(class_id, first_name, last_name, matricule, parent_phone) VALUES ($1, 'Aya', 'Relance QA', 'QA-RELANCE', '2250700088801') RETURNING id", [klass!.id]);
    studentId = student!.id;
    const [otherStudent] = await queryTenant<{ id: string }>(
      "INSERT INTO students(class_id, first_name, last_name, matricule) VALUES ($1, 'Autre', 'Famille QA', 'QA-AUTRE') RETURNING id", [klass!.id]);
    const hash = await argon2.hash('ParentRelance!2026');
    for (const [phone, linkedStudent] of [['2250700088801', studentId], ['2250700088802', otherStudent!.id]]) {
      const [parent] = await queryTenant<{ id: string }>(
        "INSERT INTO parents(full_name, phone, password_hash, is_active, must_change_password) VALUES ('Parent relance QA', $1, $2, true, false) RETURNING id", [phone, hash]);
      await queryTenant('INSERT INTO parent_student_links(parent_id, student_id) VALUES ($1,$2)', [parent!.id, linkedStudent]);
      const login = await request().post('/api/v1/auth/login/parent').set('x-tenant-schema', TEST_SCHEMA_NAME)
        .send({ phone, password: 'ParentRelance!2026' });
      expect(login.status, JSON.stringify(login.body)).toBe(200);
      const headers = { authorization: 'Bearer ' + login.body.accessToken };
      if (linkedStudent === studentId) { parentId = parent!.id; parentHeaders = headers; }
      else { otherHeaders = headers; }
    }
    await queryTenant(
      "INSERT INTO student_financial_status (student_id, school_year_id, total_expected_to_date, total_paid, total_due_year, status, days_late, last_computed_at) VALUES ($1,$2,40000,0,120000,'late',10,NOW())", [studentId, yearId]);
    await queryTenant("INSERT INTO financial_alert_rules(type, days_offset, channel, is_active) VALUES ('late',3,'in_app',true)");
  });

  it('dépose chez le parent lié, jamais chez le directeur ou une autre famille ; lecture isolée', async () => {
    expect(await run()).toEqual({ sentCount: 1, skippedCount: 0 });
    const inbox = await request().get('/api/v1/parent/notifications').set(parentHeaders);
    expect(inbox.status).toBe(200);
    expect(inbox.body.unreadCount).toBe(1);
    expect(inbox.body.notifications).toEqual([expect.objectContaining({ studentId, studentName: 'Aya Relance QA', readAt: null })]);
    const id = inbox.body.notifications[0].id as string;
    const recipients = await queryTenant<{ recipient_id: string }>("SELECT recipient_id FROM notifications_log WHERE related_id=$1 AND channel='in_app'", [studentId]);
    expect(recipients).toEqual([{ recipient_id: parentId }]);
    const other = await request().get('/api/v1/parent/notifications').set(otherHeaders);
    expect(other.body).toEqual({ notifications: [], unreadCount: 0 });
    expect((await request().patch('/api/v1/parent/notifications/' + id + '/read').set(otherHeaders)).status).toBe(404);
    expect((await request().get('/api/v1/parent/notifications').set(await getAuthHeaders('director'))).status).toBe(403);
    expect((await request().patch('/api/v1/parent/notifications/' + id + '/read').set(parentHeaders)).status).toBe(200);
    const read = await request().get('/api/v1/parent/notifications').set(parentHeaders);
    expect(read.body.unreadCount).toBe(0);
    expect(read.body.notifications[0].readAt).toEqual(expect.any(String));
    expect(await run()).toEqual({ sentCount: 0, skippedCount: 1 });
  });

  it('réessaie un canal en échec sans dupliquer le canal déjà livré', async () => {
    await queryTenant("UPDATE financial_alert_rules SET channel='both' WHERE type='late'");
    const add = vi.fn().mockRejectedValueOnce(new Error('provider unavailable')).mockResolvedValue({ id: 'queued-qa' });
    expect(await run({ add })).toEqual({ sentCount: 0, skippedCount: 0 });
    expect(await run({ add })).toEqual({ sentCount: 1, skippedCount: 0 });
    expect(add).toHaveBeenCalledTimes(2);
    expect(add.mock.calls[1]?.[1]).toMatchObject({ schemaName: TEST_SCHEMA_NAME, notificationType: 'payment_reminder' });
    const inbox = await request().get('/api/v1/parent/notifications').set(parentHeaders);
    expect(inbox.body.notifications).toHaveLength(1);
    expect(await run({ add })).toEqual({ sentCount: 0, skippedCount: 1 });
    const logs = await queryTenant<{ channel: string; status: string }>('SELECT channel, status FROM financial_alert_logs ORDER BY sent_at');
    expect(logs).toEqual([{ channel: 'in_app', status: 'sent' }, { channel: 'sms', status: 'failed' }, { channel: 'sms', status: 'sent' }]);
  });

  it('ne livre pas à un parent inactif et reprend après réactivation', async () => {
    await queryTenant("UPDATE financial_alert_rules SET is_active=false");
    await queryTenant("INSERT INTO financial_alert_rules(type, days_offset, channel, is_active) VALUES ('severe_late',5,'in_app',true)");
    await queryTenant('UPDATE parents SET is_active=false WHERE id=$1', [parentId]);
    expect((await run()).sentCount).toBe(0);
    await queryTenant('UPDATE parents SET is_active=true WHERE id=$1', [parentId]);
    expect((await run()).sentCount).toBe(1);
    const inbox = await request().get('/api/v1/parent/notifications').set(parentHeaders);
    expect(inbox.body.notifications).toHaveLength(2);
    expect((await request().patch('/api/v1/parent/notifications/read-all').set(parentHeaders)).status).toBe(200);
    expect((await request().get('/api/v1/parent/notifications').set(parentHeaders)).body.unreadCount).toBe(0);
  });

  it('ne relance pas une échéance déjà couverte, y compris avec remise ou courbe individuelle', async () => {
    await queryTenant("UPDATE financial_alert_rules SET is_active=false");
    await queryTenant("INSERT INTO financial_alert_rules(type, days_offset, channel, is_active) VALUES ('preventive',3,'in_app',true)");
    const [plan] = await queryTenant<{ id: string }>(
      "INSERT INTO tuition_plans(level_id, school_year_id, total_amount, currency) SELECT level_id, $1, 120000, 'FCFA' FROM classes WHERE name=$2 RETURNING id", [yearId, getSeedContext().className]);
    await queryTenant("INSERT INTO tuition_schedule_steps(tuition_plan_id, due_date, cumulative_amount_expected) VALUES ($1,CURRENT_DATE+1,40000)", [plan!.id]);
    await queryTenant("UPDATE student_financial_status SET status='up_to_date', days_late=NULL, total_paid=40000 WHERE student_id=$1", [studentId]);
    expect((await run()).sentCount).toBe(0);
    await queryTenant('UPDATE student_financial_status SET total_paid=0, waived_amount=40000 WHERE student_id=$1', [studentId]);
    expect((await run()).sentCount).toBe(0);
    await queryTenant('UPDATE student_financial_status SET total_paid=40000, waived_amount=0 WHERE student_id=$1', [studentId]);
    await queryTenant("INSERT INTO student_tuition_schedule_steps(student_id, school_year_id, due_date, cumulative_amount_expected) VALUES ($1,$2,CURRENT_DATE+1,60000)", [studentId, yearId]);
    await queryTenant('UPDATE student_financial_status SET total_due_year=30000 WHERE student_id=$1', [studentId]);
    expect((await run()).sentCount).toBe(0);
    await queryTenant('UPDATE student_financial_status SET total_due_year=120000 WHERE student_id=$1', [studentId]);
    expect((await run()).sentCount).toBe(1);
    const inbox = await request().get('/api/v1/parent/notifications').set(parentHeaders);
    expect(inbox.body.notifications[0].message).toContain('approche');
    expect(inbox.body.notifications[0].message).not.toContain('en retard');
  });

  it('fournit l’identifiant de l’année active utilisable pour consulter le solde parent', async () => {
    await queryPublic("UPDATE public.tenants SET active_school_year='09/2026 - 06/2027' WHERE schema_name=$1", [TEST_SCHEMA_NAME]);
    const config = await request().get('/api/v1/parent/school-config').set(parentHeaders);
    expect(config.status).toBe(200);
    expect(config.body.activeSchoolYear).toBe(yearId);
    const balance = await request().get('/api/v1/parent/students/' + studentId + '/financial-status')
      .query({ school_year_id: config.body.activeSchoolYear }).set(parentHeaders);
    expect(balance.status, JSON.stringify(balance.body)).toBe(200);
    expect(balance.body.financialStatus.totalDue).toBe(120000);
    await queryTenant("UPDATE school_years SET status='closed' WHERE id=$1", [yearId]);
    expect((await request().get('/api/v1/parent/school-config').set(parentHeaders)).body.activeSchoolYear).toBeNull();
  });
});
