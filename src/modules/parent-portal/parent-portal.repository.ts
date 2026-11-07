import { sql } from 'drizzle-orm';
import { visibleReportCardRank } from '../../shared/database/report-card-visible-rank.js';
import { confirmedSchoolStudent } from '../../shared/database/confirmed-school-membership.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { todayInBusinessTimezone } from '../../shared/utils/business-time.js';
import { listEligibleParentStudentIds } from '../../shared/auth/parent-eligibility.js';

export type TenantDb = Pick<NodePgDatabase<Record<string, unknown>>, 'execute'>;

export type ParentGradeContext = {
  schoolYearId: string;
  schoolYearLabel: string;
  classId: string;
};

export type ParentGradePeriodRow = {
  id: string;
  label: string;
  orderIndex: number;
  isCurrent: boolean;
};

export type ParentGradeSubjectRow = {
  id: string;
  name: string;
  average: number | null;
  evaluationId: string | null;
  evaluationLabel: string | null;
  evaluationDate: string | null;
  evaluationType: 'scheduled' | 'spontaneous' | null;
  coefficient: number | null;
  score: number | null;
  maxScore: number | null;
};

type ParentRow = {
  id: string;
  phone: string;
  full_name: string;
  email: string | null;
  password_hash: string;
  must_change_password: boolean;
  is_active: boolean;
};

type StudentSummaryRow = {
  id: string;
  first_name: string;
  last_name: string;
  class_name: string;
};

type ActiveSubscriptionRow = {
  id: string;
  status: 'active' | 'expired' | 'cancelled';
  starts_at: string;
  ends_at: string;
  student_count: number;
  total_amount_fcfa: number;
  duration_months: number;
  auto_renew_alert: boolean;
};

type ScheduleRow = {
  schedule_id: string;
  day_of_week: number;
  subject: string;
  level_subjects: Array<{ name: string; abbreviation: string | null }>;
  room_name: string;
  teacher_name: string;
  start_time: string;
  end_time: string;
  slot_label: string;
};

type StudentAttendanceRow = {
  schedule_id: string;
  date: string;
  status: 'present' | 'absent' | 'excused';
};

type AbsenceRow = {
  date: string;
  time_label: string;
  subject: string;
  teacher_name: string;
  room_name: string;
};

type ParentNotificationRow = {
  id: string;
  type: 'payment_reminder';
  message: string;
  created_at: string;
  metadata: unknown;
};

export class ParentPortalRepository {
  constructor(private readonly db: TenantDb) {}

  async getSmsOfferSettings() {
    const result = await this.db.execute<{
      is_enabled: boolean;
      monetize_parent_alerts: boolean;
      sms_unit_price_fcfa: number | null;
    }>(sql`
      SELECT COALESCE(f.is_enabled, false) AS is_enabled,
             COALESCE(f.monetize_parent_alerts, false) AS monetize_parent_alerts,
             f.sms_unit_price_fcfa
      FROM public.tenants t
      LEFT JOIN public.school_sms_features f ON f.tenant_id = t.id
      WHERE t.schema_name = current_schema()
      LIMIT 1
    `);
    return result.rows[0] ?? null;
  }

  async getActiveSchoolYearId(): Promise<string | null> {
    const result = await this.db.execute<{ id: string }>(sql`
      SELECT id::text FROM school_years WHERE status = 'active' LIMIT 1
    `);
    return result.rows[0]?.id ?? null;
  }

  async getStudentActiveGradeContext(studentId: string): Promise<ParentGradeContext | null> {
    const result = await this.db.execute<ParentGradeContext>(sql`
      SELECT sy.id::text AS "schoolYearId", sy.label AS "schoolYearLabel", c.id::text AS "classId"
      FROM students s
      INNER JOIN enrollments e ON e.student_id = s.id AND e.status = 'confirmed'
      INNER JOIN school_years sy ON sy.id = e.school_year_id AND sy.status = 'active'
      INNER JOIN classes c ON c.id = e.class_id AND c.school_year_id = sy.id AND c.is_active = true
      WHERE s.id = ${studentId}::uuid
        AND s.is_active = true
        AND s.lifecycle_status = 'active'
        AND ${confirmedSchoolStudent(sql`s.id`, sql`sy.id`, sql`c.id`)}
      ORDER BY sy.start_date DESC, e.created_at DESC, c.id::text ASC
      LIMIT 1
    `);
    return result.rows[0] ?? null;
  }

  async listGradePeriods(schoolYearId: string): Promise<ParentGradePeriodRow[]> {
    const result = await this.db.execute<{
      id: string;
      label: string;
      order_index: number;
      is_current: boolean;
    }>(sql`
      SELECT id::text, label, order_index,
        ${todayInBusinessTimezone()}::date BETWEEN start_date AND end_date AS is_current
      FROM grading_periods
      WHERE school_year_id = ${schoolYearId}::uuid
      ORDER BY order_index DESC, start_date DESC, id::text ASC
    `);
    return result.rows.map((row) => ({
      id: row.id,
      label: row.label,
      orderIndex: row.order_index,
      isCurrent: row.is_current,
    }));
  }

  async listAvailableSubjectGrades(input: {
    studentId: string;
    classId: string;
    schoolYearId: string;
    gradingPeriodId: string;
  }): Promise<ParentGradeSubjectRow[]> {
    const result = await this.db.execute<ParentGradeSubjectRow>(sql`
      WITH eligible_students AS (
        SELECT student.id
        FROM students student
        INNER JOIN classes c ON c.id = ${input.classId}::uuid
        WHERE student.is_active = true
          AND student.lifecycle_status = 'active'
          AND ${confirmedSchoolStudent(sql`student.id`, sql`c.school_year_id`, sql`c.id`)}
      )
      SELECT subject.id::text AS id, subject.name,
        CASE WHEN completion.status = 'completed' THEN average.average::float8 ELSE NULL END AS average,
        evaluation.id::text AS "evaluationId",
        evaluation.label AS "evaluationLabel",
        evaluation.evaluation_date::text AS "evaluationDate",
        evaluation.type::text AS "evaluationType",
        evaluation.coefficient::float8 AS coefficient,
        CASE
          WHEN evaluation.type = 'spontaneous' AND evaluation.label LIKE 'Note spontanée -%'
            THEN -grade.score::float8
          ELSE grade.score::float8
        END AS score,
        grade.max_score::float8 AS "maxScore"
      FROM classes c
      INNER JOIN subjects subject ON subject.level_id = c.level_id
      INNER JOIN students student ON student.id = ${input.studentId}::uuid
        AND student.is_active = true
        AND student.lifecycle_status = 'active'
        AND ${confirmedSchoolStudent(sql`student.id`, sql`c.school_year_id`, sql`c.id`)}
      LEFT JOIN class_subject_completion completion
        ON completion.class_id = c.id
        AND completion.subject_id = subject.id
        AND completion.grading_period_id = ${input.gradingPeriodId}::uuid
      LEFT JOIN student_period_averages average
        ON average.student_id = student.id
        AND average.subject_id = subject.id
        AND average.grading_period_id = ${input.gradingPeriodId}::uuid
      LEFT JOIN evaluations evaluation
        ON evaluation.class_id = c.id
        AND evaluation.subject_id = subject.id
        AND evaluation.grading_period_id = ${input.gradingPeriodId}::uuid
        AND (
          evaluation.type = 'spontaneous'
          OR (
            evaluation.type = 'scheduled'
            AND NOT EXISTS (
              SELECT 1
              FROM eligible_students eligible
              LEFT JOIN evaluation_grades entered
                ON entered.evaluation_id = evaluation.id
                AND entered.student_id = eligible.id
              WHERE entered.id IS NULL
            )
          )
        )
        AND NOT (
          completion.status = 'in_progress'
          AND EXISTS (
            SELECT 1
            FROM report_card_claims claim
            WHERE claim.class_id = c.id
              AND claim.subject_id = subject.id
              AND claim.grading_period_id = ${input.gradingPeriodId}::uuid
              AND claim.status = 'approved'
          )
        )
      LEFT JOIN evaluation_grades grade
        ON grade.evaluation_id = evaluation.id
        AND grade.student_id = student.id
      WHERE c.id = ${input.classId}::uuid
        AND c.school_year_id = ${input.schoolYearId}::uuid
        AND c.is_active = true
        AND (
          completion.status = 'completed'
          OR evaluation.id IS NOT NULL
        )
        AND NOT (
          completion.status = 'in_progress'
          AND EXISTS (
            SELECT 1
            FROM report_card_claims claim
            WHERE claim.class_id = c.id
              AND claim.subject_id = subject.id
              AND claim.grading_period_id = ${input.gradingPeriodId}::uuid
              AND claim.status = 'approved'
          )
        )
      ORDER BY subject.name ASC, evaluation.evaluation_date ASC NULLS LAST,
        evaluation.created_at ASC, evaluation.id::text ASC
    `);
    return result.rows;
  }

  async getStudentConductGrade(input: {
    studentId: string;
    classId: string;
    schoolYearId: string;
    gradingPeriodId: string;
  }): Promise<number | null> {
    const result = await this.db.execute<{ note: number }>(sql`
      SELECT conduct.note::float8 AS note
      FROM conduct_grades conduct
      INNER JOIN grading_periods period
        ON period.id = conduct.grading_period_id
        AND period.school_year_id = ${input.schoolYearId}::uuid
      INNER JOIN classes c
        ON c.id = ${input.classId}::uuid
        AND c.school_year_id = period.school_year_id
        AND c.is_active = true
      INNER JOIN students student
        ON student.id = conduct.student_id
        AND student.is_active = true
        AND student.lifecycle_status = 'active'
      WHERE conduct.student_id = ${input.studentId}::uuid
        AND conduct.grading_period_id = ${input.gradingPeriodId}::uuid
        AND ${confirmedSchoolStudent(sql`student.id`, sql`c.school_year_id`, sql`c.id`)}
      LIMIT 1
    `);
    return result.rows[0]?.note ?? null;
  }

  async hasApprovedGradeRevision(input: {
    classId: string;
    gradingPeriodId: string;
  }): Promise<boolean> {
    const result = await this.db.execute<{ in_revision: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
        FROM report_card_claims claim
        INNER JOIN class_subject_completion completion
          ON completion.class_id = claim.class_id
          AND completion.subject_id = claim.subject_id
          AND completion.grading_period_id = claim.grading_period_id
          AND completion.status = 'in_progress'
        INNER JOIN classes c ON c.id = claim.class_id
        INNER JOIN subjects subject ON subject.id = claim.subject_id
          AND subject.level_id = c.level_id
        WHERE claim.class_id = ${input.classId}::uuid
          AND claim.grading_period_id = ${input.gradingPeriodId}::uuid
          AND claim.status = 'approved'
      ) AS in_revision
    `);
    return result.rows[0]?.in_revision ?? false;
  }

  async findParentByPhone(phone: string): Promise<ParentRow | null> {
    const result = await this.db.execute<ParentRow>(sql`
      SELECT id::text, phone, full_name, email, password_hash, must_change_password, is_active
      FROM parents
      WHERE phone = ${phone}
      LIMIT 1
    `);
    return result.rows[0] ?? null;
  }

  async findParentById(parentId: string): Promise<ParentRow | null> {
    const result = await this.db.execute<ParentRow>(sql`
      SELECT id::text, phone, password_hash, must_change_password, is_active
      FROM parents
      WHERE id = ${parentId}::uuid
      LIMIT 1
    `);
    return result.rows[0] ?? null;
  }

  async updateParentLastLogin(parentId: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE parents
      SET last_login_at = NOW()
      WHERE id = ${parentId}::uuid
    `);
  }

  async updateParentPassword(parentId: string, passwordHash: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE parents
      SET password_hash = ${passwordHash},
          must_change_password = false
      WHERE id = ${parentId}::uuid
    `);
  }

  async listNotifications(parentId: string, limit: number): Promise<ParentNotificationRow[]> {
    const result = await this.db.execute<ParentNotificationRow>(sql`
      SELECT id::text, type::text AS type, message, created_at::text, metadata
      FROM notifications_log
      WHERE recipient_id = ${parentId}::uuid
        AND channel = 'in_app'
        AND type = 'payment_reminder'
      ORDER BY created_at DESC
      LIMIT ${limit}
    `);
    return result.rows;
  }

  async countUnreadNotifications(parentId: string): Promise<number> {
    const result = await this.db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM notifications_log
      WHERE recipient_id = ${parentId}::uuid
        AND channel = 'in_app'
        AND type = 'payment_reminder'
        AND metadata->>'read_at' IS NULL
    `);
    return result.rows[0]?.count ?? 0;
  }

  async findNotification(notificationId: string, parentId: string): Promise<boolean> {
    const result = await this.db.execute<{ id: string }>(sql`
      SELECT id::text
      FROM notifications_log
      WHERE id = ${notificationId}::uuid
        AND recipient_id = ${parentId}::uuid
        AND channel = 'in_app'
        AND type = 'payment_reminder'
      LIMIT 1
    `);
    return result.rows.length > 0;
  }

  async markNotificationRead(notificationId: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE notifications_log
      SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('read_at', NOW()::text)
      WHERE id = ${notificationId}::uuid
    `);
  }

  async markAllNotificationsRead(parentId: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE notifications_log
      SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('read_at', NOW()::text)
      WHERE recipient_id = ${parentId}::uuid
        AND channel = 'in_app'
        AND type = 'payment_reminder'
    `);
  }

  async listLinkedStudentIds(parentId: string): Promise<string[]> {
    return listEligibleParentStudentIds(this.db, parentId);
  }

  async listStudentsByParent(parentId: string): Promise<StudentSummaryRow[]> {
    const result = await this.db.execute<StudentSummaryRow>(sql`
      SELECT
        DISTINCT s.id::text AS id,
        s.first_name,
        s.last_name,
        c.name AS class_name
      FROM parent_student_links psl
      INNER JOIN students s ON s.id = psl.student_id
      INNER JOIN classes c ON ${confirmedSchoolStudent(sql`s.id`, sql`c.school_year_id`, sql`c.id`)}
      INNER JOIN school_years sy ON sy.id = c.school_year_id AND sy.status = 'active'
      WHERE psl.parent_id = ${parentId}::uuid
        AND s.is_active = true
        AND s.lifecycle_status = 'active'
      ORDER BY s.last_name ASC, s.first_name ASC
    `);

    return result.rows;
  }

  async parentCanAccessStudent(parentId: string, studentId: string): Promise<boolean> {
    return (await listEligibleParentStudentIds(this.db, parentId)).includes(studentId);
  }

  async getStudentClassId(studentId: string): Promise<string | null> {
    const result = await this.db.execute<{ class_id: string }>(sql`
      SELECT c.id::text AS class_id
      FROM classes c INNER JOIN school_years sy ON sy.id = c.school_year_id AND sy.status = 'active'
      WHERE ${confirmedSchoolStudent(sql`${studentId}::uuid`, sql`c.school_year_id`, sql`c.id`)}
      LIMIT 1
    `);

    return result.rows[0]?.class_id ?? null;
  }

  async listWeekSchedulesForClass(input: {
    classId: string;
    weekStart: string;
    weekEnd: string;
  }): Promise<ScheduleRow[]> {
    const result = await this.db.execute<ScheduleRow>(sql`
      SELECT
        s.id::text AS schedule_id,
        s.day_of_week,
        s.subject,
        COALESCE((
          SELECT json_agg(json_build_object('name', sub.name, 'abbreviation', sub.abbreviation) ORDER BY sub.id)
          FROM subjects sub
          INNER JOIN classes c ON c.level_id = sub.level_id
          WHERE c.id = s.class_id
        ), '[]'::json) AS level_subjects,
        r.name AS room_name,
        u.name AS teacher_name,
        ts.start_time::text AS start_time,
        ts.end_time::text AS end_time,
        ts.label AS slot_label
      FROM schedules s
      INNER JOIN schedule_periods sp ON sp.id = s.schedule_period_id
      INNER JOIN teachers t ON t.id = s.teacher_id
      INNER JOIN users u ON u.id = t.user_id
      INNER JOIN rooms r ON r.id = s.room_id
      INNER JOIN time_slots ts ON ts.id = s.time_slot_id
      AND NOT EXISTS (
        SELECT 1 FROM schedule_exceptions se
        WHERE se.schedule_id = s.id
          AND se.exception_date BETWEEN ${input.weekStart}::date AND ${input.weekEnd}::date
          AND EXTRACT(ISODOW FROM se.exception_date)::int = s.day_of_week
      )
      WHERE s.class_id = ${input.classId}::uuid
        AND s.is_active = true
        AND sp.is_active = true
        AND sp.valid_from <= ${input.weekEnd}::date
        AND sp.valid_to >= ${input.weekStart}::date
      ORDER BY s.day_of_week ASC, ts.sort_order ASC, ts.start_time ASC
    `);

    return result.rows;
  }

  async listAttendancesForStudentInRange(input: {
    studentId: string;
    from: string;
    to: string;
  }): Promise<StudentAttendanceRow[]> {
    // ce query est volontairement simple pour éviter de faire des jointures complexes et risquer de rater des enregistrements d'absences
    // on récupère simplement tous les enregistrements d'attendance pour l'étudiant dans la période donnée, et on laisse la logique métier de l'application décider comment les interpréter 
    // (ex: si un cours est manqué mais qu'il y a une exception de planning, c'est à l'application de décider si c'est une absence ou pas)
    const result = await this.db.execute<StudentAttendanceRow>(sql`
      SELECT
        schedule_id::text AS schedule_id,
        date::text AS date,
        status::text AS status
      FROM attendances_student
      WHERE student_id = ${input.studentId}::uuid
        AND date BETWEEN ${input.from}::date AND ${input.to}::date
    `);

    return result.rows;
  }

  async listAbsencesByStudentAndMonth(input: {
    studentId: string;
    monthStart: string;
    monthEnd: string;
  }): Promise<AbsenceRow[]> {
    const result = await this.db.execute<AbsenceRow>(sql`
      SELECT
        a.date::text AS date,
        ts.label AS time_label,
        s.subject,
        u.name AS teacher_name,
        r.name AS room_name
      FROM attendances_student a
      INNER JOIN schedules s ON s.id = a.schedule_id
      INNER JOIN teachers t ON t.id = s.teacher_id
      INNER JOIN users u ON u.id = t.user_id
      INNER JOIN rooms r ON r.id = s.room_id
      INNER JOIN time_slots ts ON ts.id = s.time_slot_id
      WHERE a.student_id = ${input.studentId}::uuid
        AND a.status = 'absent'
        AND a.date BETWEEN ${input.monthStart}::date AND ${input.monthEnd}::date
        AND NOT EXISTS (
          SELECT 1 FROM schedule_exceptions se
          WHERE se.schedule_id = s.id AND se.exception_date = a.date
        )
      ORDER BY a.date DESC, ts.start_time DESC
    `);

    return result.rows;
  }

  async getActiveOrLatestSubscription(parentId: string): Promise<ActiveSubscriptionRow | null> {
    const businessToday = todayInBusinessTimezone();
    const result = await this.db.execute<ActiveSubscriptionRow>(sql`
      SELECT
        id::text,
        status::text AS status,
        starts_at::text,
        ends_at::text,
        student_count,
        total_amount_fcfa,
        duration_months,
        auto_renew_alert
      FROM parent_subscriptions
      WHERE parent_id = ${parentId}::uuid
      ORDER BY
        CASE WHEN status = 'active' AND ends_at >= ${businessToday}::date THEN 0 ELSE 1 END,
        ends_at DESC,
        created_at DESC
      LIMIT 1
    `);

    return result.rows[0] ?? null;
  }

  async countAbsencesForStudentInRange(input: {
    studentId: string;
    from: string;
    to: string;
  }): Promise<number> {
    const result = await this.db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM attendances_student
      WHERE student_id = ${input.studentId}::uuid
        AND status = 'absent'
        AND date BETWEEN ${input.from}::date AND ${input.to}::date
    `);

    return result.rows[0]?.count ?? 0;
  }

  async countAttendanceBreakdownForStudentMonth(input: {
    studentId: string;
    monthStart: string;
    monthEnd: string;
  }): Promise<{ present: number; absent: number; total: number }> {
    const result = await this.db.execute<{ present_count: number; absent_count: number; total_count: number }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('present', 'excused'))::int AS present_count,
        COUNT(*) FILTER (WHERE status = 'absent')::int AS absent_count,
        COUNT(*) FILTER (WHERE status IN ('present', 'excused', 'late', 'absent'))::int AS total_count
      FROM attendances_student
      WHERE student_id = ${input.studentId}::uuid
        AND date BETWEEN ${input.monthStart}::date AND ${input.monthEnd}::date
    `);

    return {
      present: result.rows[0]?.present_count ?? 0,
      absent: result.rows[0]?.absent_count ?? 0,
      total: result.rows[0]?.total_count ?? 0,
    };
  }

  /**
   * Vue d'ensemble enrichie (Tâche 17b) : statut financier caché (6a) et
   * dernier bulletin publié (5c) d'un élève. Lecture seule du cache.
   */
  async getParentOverview(studentId: string): Promise<{
    financial: {
      status: 'up_to_date' | 'late';
      daysLate: number | null;
      totalPaid: number;
      totalDueYear: number;
      remainingDue: number;
      lastComputedAt: string;
    } | null;
    latestPublishedReportCard: {
      id: string;
      periodLabel: string;
      schoolYearLabel: string;
      generalAverage: number;
      rank: number;
      classHeadcount: number;
      publishedAt: string;
    } | null;
  }> {
    const financialResult = await this.db.execute<{
      status: string;
      days_late: number | null;
      total_paid: string;
      total_due_year: string;
      last_computed_at: string;
    }>(sql`
      SELECT sfs.status::text, sfs.days_late, sfs.total_paid::text,
             sfs.total_due_year::text,
             sfs.last_computed_at::text
      FROM student_financial_status sfs
      INNER JOIN enrollments e ON e.student_id = sfs.student_id
        AND e.school_year_id = sfs.school_year_id AND e.status = 'confirmed'
      INNER JOIN students s ON s.id = e.student_id AND s.is_active = true
      INNER JOIN classes c ON c.id = e.class_id
        AND c.school_year_id = e.school_year_id AND c.is_active = true
      WHERE sfs.student_id = ${studentId}::uuid
        AND sfs.school_year_id = (SELECT id FROM school_years WHERE status = 'active' LIMIT 1)
      LIMIT 1
    `);
    const financialRow = financialResult.rows?.[0];

    const reportCardResult = await this.db.execute<{
      id: string;
      period_label: string;
      school_year_label: string;
      general_average: string;
      rank: number;
      class_headcount: number;
      published_at: string;
    }>(sql`
      SELECT rc.id::text, gp.label AS period_label, sy.label AS school_year_label,
             rc.general_average::text, ${visibleReportCardRank} AS rank, rc.class_headcount, rc.published_at::text
      FROM report_cards rc
      INNER JOIN grading_periods gp ON gp.id = rc.grading_period_id
      INNER JOIN school_years sy ON sy.id = gp.school_year_id
      WHERE rc.student_id = ${studentId}::uuid AND rc.status = 'published'
      ORDER BY rc.published_at DESC
      LIMIT 1
    `);
    const cardRow = reportCardResult.rows?.[0];

    const paid = financialRow ? Number(financialRow.total_paid) : 0;
    return {
      financial: financialRow
        ? {
            status: financialRow.status as 'up_to_date' | 'late',
            daysLate: financialRow.days_late,
            totalPaid: paid,
            totalDueYear: Number(financialRow.total_due_year),
            remainingDue: Math.max(0, Number(financialRow.total_due_year) - paid),
            lastComputedAt: financialRow.last_computed_at,
          }
        : null,
      latestPublishedReportCard: cardRow
        ? {
            id: cardRow.id,
            periodLabel: cardRow.period_label,
            schoolYearLabel: cardRow.school_year_label,
            generalAverage: Number(cardRow.general_average),
            rank: cardRow.rank,
            classHeadcount: cardRow.class_headcount,
            publishedAt: cardRow.published_at,
          }
        : null,
    };
  }

  async getActiveSchoolYearLabel(): Promise<string | null> {
    const result = await this.db.execute<{ label: string }>(sql`
      SELECT label FROM school_years WHERE status = 'active' LIMIT 1
    `);
    return result.rows?.[0]?.label ?? null;
  }
}
