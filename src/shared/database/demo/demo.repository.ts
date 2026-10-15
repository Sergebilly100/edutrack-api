import { sql, type SQL } from 'drizzle-orm';
import type { TenantDb } from '../db.js';
import type { DemoOptions } from './demo.config.js';

type Value = string | number | boolean | null | SQL;
const tables = [
  'users', 'teachers', 'school_years', 'grading_periods', 'levels', 'classes', 'subjects',
  'rooms', 'time_slots', 'schedule_periods', 'schedules', 'teacher_subject_assignments',
  'students', 'enrollments', 'parents', 'parent_subscriptions', 'parent_student_links',
  'subscription_payments', 'tuition_plans', 'tuition_schedule_steps', 'student_tuition_overrides',
  'student_tuition_schedule_agreements', 'student_tuition_schedule_steps', 'payments', 'attendances_teacher', 'attendances_student',
  'import_history', 'student_historical_sources',
] as const;

export class DemoRepository {
  constructor(readonly db: TenantDb) {}

  async reserve(options: DemoOptions): Promise<string> {
    const schema = `school_${options.name}`;
    await this.db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${schema}))`);
    const existing = await this.db.execute(sql`
      SELECT 1 FROM pg_namespace WHERE nspname = ${schema}
      UNION ALL SELECT 1 FROM public.tenants WHERE schema_name = ${schema} OR subdomain = ${options.name.replaceAll('_', '-')}
    `);
    if (existing.rows.length) throw new Error('DEMO_ALREADY_EXISTS: choisissez un nouveau nom ; aucun tenant existant ne sera modifié.');
    const result = await this.db.execute<{ id: string }>(sql`
      INSERT INTO public.tenants (name, subdomain, schema_name, plan, status, city, teaching_type,
        max_users, onboarding_completed, mid_year_onboarding)
      VALUES (${`Collège des Flamboyants - Démo ${options.name}`}, ${options.name.replaceAll('_', '-')},
        ${schema}, 'pro', 'active', 'Yamoussoukro', 'secondaire', 50, ${options.type === 'seeded'}, false)
      RETURNING id
    `);
    return result.rows[0]!.id;
  }

  async migrate(schema: string, statements: string[]): Promise<void> {
    // All identifiers/statements come from the validated, reviewed migration plan.
    for (const statement of statements) {
      await this.db.execute(sql`SAVEPOINT demo_migration`);
      try {
        await this.db.execute(sql.raw(statement));
      } catch (error) {
        await this.db.execute(sql`ROLLBACK TO SAVEPOINT demo_migration`);
        const cause = error instanceof Error && 'cause' in error ? error.cause : error;
        const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : '';
        const view = /CREATE\s+OR\s+REPLACE\s+VIEW\s+("[a-z0-9_]+"\."[a-z0-9_]+")/i.exec(statement);
        if (code === '42P16' && view?.[1]?.startsWith(`"${schema}".`)) {
          await this.db.execute(sql.raw(`DROP VIEW ${view[1]}`));
          await this.db.execute(sql.raw(statement));
        } else if (!['42P07', '42710', '42701'].includes(String(code))) {
          throw new Error(`DEMO_MIGRATION_FAILED (${String(code)})`, { cause: error });
        }
      } finally {
        await this.db.execute(sql`RELEASE SAVEPOINT demo_migration`);
      }
    }
    await this.db.execute(sql.raw(`SET LOCAL search_path TO "${schema}", public`));
  }

  async verifyConductMigration(): Promise<void> {
    const result = await this.db.execute<{ columns_ready: boolean; tables_ready: boolean; constraints_ready: boolean }>(sql`
      SELECT
        (SELECT COUNT(*) = 2 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'school_years'
           AND column_name IN ('conduct_decision_mode', 'conduct_coefficient')
           AND is_nullable = 'NO' AND column_default IS NOT NULL) AS columns_ready,
        (SELECT COUNT(*) = 2 FROM information_schema.tables
         WHERE table_schema = current_schema()
           AND table_name IN ('conduct_grade_audit', 'conduct_policy_audit')) AS tables_ready,
        (SELECT COUNT(*) = 6 FROM pg_constraint con
         INNER JOIN pg_namespace ns ON ns.oid = con.connamespace
         WHERE ns.nspname = current_schema()
           AND con.conname IN (
             'conduct_grade_audit_conduct_grade_id_conduct_grades_id_fk',
             'conduct_grade_audit_changed_by_user_id_users_id_fk',
             'conduct_policy_audit_school_year_id_school_years_id_fk',
             'conduct_policy_audit_changed_by_user_id_users_id_fk',
             'school_years_conduct_mode',
             'school_years_conduct_coefficient_positive'
           )) AS constraints_ready
    `);
    const status = result.rows[0];
    if (!status?.columns_ready || !status.tables_ready || !status.constraints_ready) {
      throw new Error('DEMO_CONDUCT_MIGRATION_CONTRACT_FAILED');
    }
  }

  async configureTenant(tenantId: string, seeded: boolean, yearLabel?: string): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO public.school_sms_features (
        tenant_id, is_enabled, monetize_parent_alerts, commission_pct, sms_cap_per_student, sms_unit_price_fcfa
      )
      VALUES (${tenantId}::uuid, ${seeded}, ${seeded}, 0, ${seeded ? 60 : 0}, ${seeded ? 1000 : null})
    `);
    await this.db.execute(sql`
      INSERT INTO public.subscriptions (tenant_id, status, mrr_fcfa, billing_cycle, current_period_start, current_period_end)
      VALUES (${tenantId}::uuid, 'active', 0, 'annual', CURRENT_DATE, CURRENT_DATE + INTERVAL '1 year')
    `);
    if (yearLabel) await this.db.execute(sql`UPDATE public.tenants SET active_school_year = ${yearLabel} WHERE id = ${tenantId}::uuid`);
  }

  async insert(table: typeof tables[number], fields: Record<string, Value>): Promise<string> {
    if (!tables.includes(table)) throw new Error('DEMO_INVALID_TABLE');
    const entries = Object.entries(fields);
    const result = await this.db.execute<{ id: string }>(sql`
      INSERT INTO ${sql.identifier(table)} (${sql.join(entries.map(([key]) => sql.identifier(key)), sql`, `)})
      VALUES (${sql.join(entries.map(([, value]) => sql`${value}`), sql`, `)}) RETURNING id
    `);
    return result.rows[0]!.id;
  }

  async setPeriodReviewStart(periodId: string, reviewStartDate: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE grading_periods SET review_start_date = ${reviewStartDate}::date
      WHERE id = ${periodId}::uuid
    `);
  }

  async finalizePeriodCalendar(periodId: string, reviewStartDate: string, endDate: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE grading_periods
      SET review_start_date = ${reviewStartDate}::date, end_date = ${endDate}::date
      WHERE id = ${periodId}::uuid
    `);
  }

  async dateAcademicHistory(periodId: string, end: string): Promise<void> {
    // Reconstruct historical timestamps after the real business transitions.
    await this.db.execute(sql`UPDATE evaluations SET created_at = evaluation_date::timestamp, updated_at = evaluation_date::timestamp WHERE grading_period_id = ${periodId}::uuid`);
    await this.db.execute(sql`UPDATE evaluation_grades g SET created_at = e.evaluation_date::timestamp, updated_at = e.evaluation_date::timestamp FROM evaluations e WHERE e.id = g.evaluation_id AND e.grading_period_id = ${periodId}::uuid`);
    await this.db.execute(sql`UPDATE class_subject_completion SET completed_at = ${end}::date, updated_at = ${end}::date WHERE grading_period_id = ${periodId}::uuid`);
    await this.db.execute(sql`UPDATE teacher_conduct_inputs SET created_at = ${end}::date, updated_at = ${end}::date WHERE grading_period_id = ${periodId}::uuid`);
    await this.db.execute(sql`UPDATE conduct_grades SET decided_at = ${end}::date WHERE grading_period_id = ${periodId}::uuid`);
    await this.db.execute(sql`UPDATE report_cards SET generated_at = ${end}::date, published_at = ${end}::date + INTERVAL '1 day', created_at = ${end}::date, updated_at = ${end}::date + INTERVAL '1 day' WHERE grading_period_id = ${periodId}::uuid`);
  }

  async archiveClasses(classIds: string[]): Promise<void> {
    if (classIds.length === 0) return;
    await this.db.execute(sql`
      UPDATE classes SET is_active = false, updated_at = NOW()
      WHERE id IN (${sql.join(classIds.map((id) => sql`${id}::uuid`), sql`, `)})
    `);
  }

  async closeSchoolYear(yearId: string): Promise<void> {
    await this.db.execute(sql`UPDATE school_years SET status = 'closed' WHERE id = ${yearId}::uuid`);
  }

  async verify(seeded: boolean) {
    const result = await this.db.execute<{
      students: number; classes: number; years: number; rooms: number; slots: number; cards: number; teachers: number; parents: number;
      historical_cards: number; historical_sources: number; risky_students: number; risky_teachers: number; teacher_absences: number;
      financial_late: number; active_parent_subscriptions: number; future_evaluations: number; partially_graded_evaluations: number;
      unresolved_schedule_subjects: number;
    }>(sql`
      SELECT (SELECT COUNT(*)::int FROM students) AS students, (SELECT COUNT(*)::int FROM classes) AS classes,
        (SELECT COUNT(*)::int FROM school_years) AS years, (SELECT COUNT(*)::int FROM rooms) AS rooms,
        (SELECT COUNT(*)::int FROM time_slots) AS slots, (SELECT COUNT(*)::int FROM report_cards WHERE status = 'published') AS cards,
        (SELECT COUNT(*)::int FROM schedules WHERE subject_id IS NULL) AS unresolved_schedule_subjects,
        (SELECT COUNT(*)::int FROM teachers) AS teachers, (SELECT COUNT(*)::int FROM parents) AS parents,
        (SELECT COUNT(*)::int FROM report_cards rc INNER JOIN grading_periods gp ON gp.id = rc.grading_period_id
          INNER JOIN school_years sy ON sy.id = gp.school_year_id WHERE rc.status = 'published' AND sy.status = 'closed') AS historical_cards,
        (SELECT COUNT(*)::int FROM student_historical_sources) AS historical_sources,
        (SELECT COUNT(*)::int FROM student_risk_status WHERE level IN ('warning','critical')) AS risky_students,
        (SELECT COUNT(*)::int FROM teacher_risk_status WHERE absences_signal) AS risky_teachers,
        (SELECT COUNT(*)::int FROM attendances_teacher WHERE status = 'absent') AS teacher_absences,
        (SELECT COUNT(*)::int FROM student_financial_status WHERE status = 'late') AS financial_late,
        (SELECT COUNT(*)::int FROM parent_subscriptions WHERE status = 'active' AND ends_at >= CURRENT_DATE) AS active_parent_subscriptions,
        (SELECT COUNT(*)::int FROM evaluations e INNER JOIN grading_periods gp ON gp.id = e.grading_period_id
          INNER JOIN school_years sy ON sy.id = gp.school_year_id
          WHERE sy.status = 'active' AND e.evaluation_date > CURRENT_DATE
            AND NOT EXISTS (SELECT 1 FROM evaluation_grades eg WHERE eg.evaluation_id = e.id)) AS future_evaluations,
        (SELECT COUNT(*)::int FROM (
          SELECT e.id FROM evaluations e INNER JOIN grading_periods gp ON gp.id = e.grading_period_id
          INNER JOIN school_years sy ON sy.id = gp.school_year_id
          LEFT JOIN evaluation_grades eg ON eg.evaluation_id = e.id
          WHERE sy.status = 'active' AND e.evaluation_date <= CURRENT_DATE
          GROUP BY e.id HAVING COUNT(eg.id) BETWEEN 1 AND 23
        ) partial) AS partially_graded_evaluations
    `);
    const counts = result.rows[0]!;
    if (seeded ? counts.students !== 72 || counts.classes !== 6 || counts.years !== 2 || counts.cards !== 162
      || counts.historical_cards !== 18 || counts.historical_sources !== 6 || counts.risky_students < 1
      || counts.risky_teachers < 1 || counts.teacher_absences < 1 || counts.financial_late < 1
      || counts.active_parent_subscriptions < 1 || counts.future_evaluations < 1 || counts.partially_graded_evaluations < 1
      || counts.unresolved_schedule_subjects !== 0
      : Object.values(counts).some((value) => value !== 0)) throw new Error('DEMO_INVARIANT_FAILED');
    return counts;
  }
}
