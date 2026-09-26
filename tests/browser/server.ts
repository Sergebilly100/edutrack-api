/** Disposable browser fixture, sharing the integration harness and real routes. */
import argon2 from 'argon2';

if (!process.env.DATABASE_URL_TEST || !process.env.QA_BROWSER_SCHEMA?.startsWith('school_test_')) {
  throw new Error('Browser QA requires DATABASE_URL_TEST and a school_test_* schema');
}
process.env.AUTH_ADMIN_SCHEMA = process.env.QA_BROWSER_SCHEMA;
process.env.SMS_MOCK = 'true';
const { startTestApp, stopTestApp, getSeedContext, queryTenant, queryPublic, getAuthHeaders, request, TEST_SCHEMA_NAME } = await import('../support/school-harness.js');
await startTestApp();
const { db } = await import('../../src/shared/database/db.js');
const { ensureAdminPublicInfrastructure } = await import('../../src/modules/admin/admin.infrastructure.service.js');
await ensureAdminPublicInfrastructure(db);
const context = getSeedContext();
await queryPublic(`INSERT INTO public.tenants (name, subdomain, schema_name, plan, status, max_users, onboarding_completed)
 VALUES ('École QA navigateur', $2, $1, 'pro', 'active', 50, true)`, [TEST_SCHEMA_NAME, TEST_SCHEMA_NAME.replaceAll('_', '-')]);
const [tenant] = await queryPublic<{ id: string }>('SELECT id FROM public.tenants WHERE schema_name=$1', [TEST_SCHEMA_NAME]);
await queryPublic(`INSERT INTO public.school_sms_features (tenant_id, is_enabled, monetize_parent_alerts, sms_unit_price_fcfa)
 VALUES ($1, true, true, 1000) ON CONFLICT (tenant_id) DO UPDATE SET is_enabled=true, monetize_parent_alerts=true, sms_unit_price_fcfa=1000`, [tenant!.id]);
const today = new Date().toISOString().slice(0, 10);
const year = new Date().getUTCFullYear();
await queryTenant("UPDATE school_years SET status='closed' WHERE status='active'");
const [schoolYear] = await queryTenant<{ id: string }>(`INSERT INTO school_years (label, start_date, end_date, end_of_year_review_start_date, status)
 VALUES ($1, $2, $3, $4, 'active') RETURNING id`, [`QA ${year}`, `${year}-01-01`, `${year+1}-12-31`, `${year+1}-11-01`]);
const [level] = await queryTenant<{ id: string }>("INSERT INTO levels (name, order_index) VALUES ('Niveau QA', 1) RETURNING id");
await queryTenant(`UPDATE classes SET name='Classe QA', level_id=$1, school_year_id=$2, homeroom_teacher_id=$3 WHERE name=$4`, [level!.id, schoolYear!.id, context.teacherId, context.className]);
await queryTenant("UPDATE teachers SET username='qa.teacher' WHERE id=$1", [context.teacherId]);
context.teacherUsername = 'qa.teacher';
await queryTenant("INSERT INTO classes (name, level_id, school_year_id) VALUES ('Classe inscription QA', $1, $2)", [level!.id, schoolYear!.id]);
const [klass] = await queryTenant<{ id: string }>("SELECT id FROM classes WHERE name='Classe QA'");
const [subject] = await queryTenant<{ id: string }>("INSERT INTO subjects (level_id, name, coefficient) VALUES ($1, 'Mathematiques', 4) RETURNING id", [level!.id]);
const [period] = await queryTenant<{ id: string }>(`INSERT INTO grading_periods (school_year_id, type, order_index, label, start_date, end_date)
 VALUES ($1, 'trimester', 1, 'Période QA', $2, $3) RETURNING id`, [schoolYear!.id, `${year}-01-01`, `${year}-12-31`]);
const director = await getAuthHeaders('director');
const teacher = await getAuthHeaders('teacher');
const assertOk = (response: { status: number; body: unknown }) => {
  if (response.status >= 400) throw new Error(`QA fixture failed: ${response.status} ${JSON.stringify(response.body)}`);
};
assertOk(await request().put(`/api/v1/tuition-plans/levels/${level!.id}`).set(director).send({ schoolYearId: schoolYear!.id, totalAmount: 120000, currency: 'FCFA', scheduleSteps: [{ dueDate: today, cumulativeAmountExpected: 120000 }] }));
const studentIds: string[] = [];
for (const firstName of ['Aya', 'Koffi']) {
  const student = await request().post('/api/v1/students').set(director).send({ class_id: klass!.id, first_name: firstName, last_name: 'Recette', matricule: `QA-${firstName}` });
  assertOk(student);
  studentIds.push(student.body.data.id);
}
for (const phone of ['2250700008899', '2250700008898']) {
  const [parent] = await queryTenant<{ id: string }>(`INSERT INTO parents (full_name, phone, password_hash, is_active, must_change_password)
    VALUES ('Parent QA', $1, $2, true, false) RETURNING id`, [phone, await argon2.hash('ParentQa!2026')]);
  for (const studentId of studentIds) await queryTenant('INSERT INTO parent_student_links (parent_id, student_id) VALUES ($1, $2)', [parent!.id, studentId]);
}
const evaluation = await request().post('/api/v1/evaluations').set(teacher).send({ classId: klass!.id, subjectId: subject!.id, gradingPeriodId: period!.id, type: 'scheduled', coefficient: 1, label: 'Devoir QA', evaluationDate: today });
assertOk(evaluation);
for (const studentId of studentIds) assertOk(await request().put(`/api/v1/evaluations/${evaluation.body.evaluation.id}/grades`).set(teacher).send({ studentId, score: 16, maxScore: 20 }));
assertOk(await request().put('/api/v1/class-subject-completion').set(teacher).send({ classId: klass!.id, subjectId: subject!.id, gradingPeriodId: period!.id, status: 'in_progress', calculationStarted: true }));

// Real financial batch: compute outstanding tuition, then deliver to linked parents.
assertOk(await request().put('/api/v1/financial-alert-rules/late').set(director).send({ daysOffset: 0, channel: 'in_app', isActive: true }));
const { runFinancialAlertsForSchema } = await import('../../src/modules/finance/financial-alerts.worker.js');
const reminders = await runFinancialAlertsForSchema({ schemaName: TEST_SCHEMA_NAME, smsQueue: undefined });
if (reminders.sentCount !== 2) throw new Error('QA fixture expected a financial reminder for each child');

// Readiness is checked after seeding; no fixture writes are exposed over HTTP.
console.log('QA browser fixture ready');
process.env.QA_BROWSER_READY = 'true';
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await stopTestApp();
  process.exit(0);
}
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
