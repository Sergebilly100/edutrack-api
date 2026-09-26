import { sql } from 'drizzle-orm';

import type { TenantDb } from '../../shared/database/db.js';
import {
  DEFAULT_RISK_RULES,
  isAbsenceRisk,
  isGradeDropRisk,
  isPaymentRisk,
  resolveRiskRule,
  resolveRollingRiskRule,
} from './risk.calculations.js';


type Rows<T> = { rows?: T[] };

const getRows = <T>(result: unknown): T[] => {
  if (typeof result !== 'object' || result === null || !('rows' in result)) {
    return [];
  }
  const rows = (result as Rows<T>).rows;
  return Array.isArray(rows) ? rows : [];
};

export type RiskRule = {
  id: string;
  subjectType: 'student' | 'teacher';
  signalType: string;
  thresholdValue: number;
  periodDays: number;
  isActive: boolean;
};

export type StudentRiskListInput = {
  page: number;
  limit: number;
  schoolLevelId?: string;
  classId?: string;
  category?: 'absences' | 'grades' | 'payments';
  riskLevel?: 'attention' | 'warning' | 'critical';
  atRisk: boolean;
  includePayments: boolean;
  studentIds?: string[];
};

export type TeacherRiskListInput = {
  page: number;
  limit: number;
  month?: string;
  atRisk: boolean;
};

export type StudentRiskRow = {
  student_id: string;
  student_name: string;
  school_level_id: string | null;
  school_level_name: string | null;
  class_id: string | null;
  class_name: string | null;
  absences_signal: boolean;
  grades_signal: boolean;
  payment_signal: boolean;
  risk_score: number;
  level: 'none' | 'attention' | 'warning' | 'critical';
  computed_at: string;
};

export type TeacherRiskRow = {
  teacher_id: string;
  teacher_name: string;
  absence_count: number;
  attendance_rate: number;
  absences_signal: boolean;
  risk_score: number;
  level: 'none' | 'attention';
};

export class RiskRepository {
  constructor(readonly db: TenantDb) {}

  async listRules(): Promise<RiskRule[]> {
    const result = await this.db.execute<{
      id: string; subject_type: string; signal_type: string;
      threshold_value: string; period_days: number; is_active: boolean;
    }>(sql`
      SELECT id::text, subject_type, signal_type, threshold_value::text, period_days, is_active
      FROM risk_alert_rules ORDER BY subject_type, signal_type
    `);
    return getRows<{
      id: string; subject_type: string; signal_type: string;
      threshold_value: string; period_days: number; is_active: boolean;
    }>(result).map((row) => ({
      id: row.id,
      subjectType: row.subject_type as RiskRule['subjectType'],
      signalType: row.signal_type,
      thresholdValue: Number(row.threshold_value),
      periodDays: row.period_days,
      isActive: row.is_active,
    }));
  }

  async upsertRule(input: {
    subjectType: 'student' | 'teacher';
    signalType: string;
    thresholdValue: number;
    periodDays: number;
    isActive: boolean;
  }): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO risk_alert_rules (subject_type, signal_type, threshold_value, period_days, is_active)
      VALUES (${input.subjectType}, ${input.signalType}, ${input.thresholdValue}, ${input.periodDays}, ${input.isActive})
      ON CONFLICT ("subject_type", "signal_type") DO UPDATE SET
        threshold_value = EXCLUDED.threshold_value,
        period_days = EXCLUDED.period_days,
        is_active = EXCLUDED.is_active,
        updated_at = NOW()
    `);
  }

  /**
   * Signaux élève en une requête : absences non justifiées sur la fenêtre,
   * baisse de moyenne générale entre les deux dernières périodes notées,
   * statut de paiement depuis le cache financier (6a).
   */
  async computeStudentSignals(): Promise<Map<string, {
    absences: { count: number; active: boolean };
    grades: { drop: number | null; active: boolean };
    payments: boolean;
  }>> {
    // Fenêtre et seuils par défaut (surchargés par les règles actives).
    const rules = await this.listRules();
    const absenceRule = rules.find((r) => r.subjectType === 'student' && r.signalType === 'absences');
    const gradeRule = rules.find((r) => r.subjectType === 'student' && r.signalType === 'grades');
    const paymentRule = rules.find((r) => r.subjectType === 'student' && r.signalType === 'payments');
    const absenceConfig = resolveRollingRiskRule(absenceRule, DEFAULT_RISK_RULES.studentAbsences);
    const gradeConfig = resolveRiskRule(gradeRule, DEFAULT_RISK_RULES.studentGrades);
    const paymentConfig = resolveRiskRule(paymentRule, DEFAULT_RISK_RULES.studentPayments);

    const absenceWindow = absenceConfig.periodDays;

    const result = await this.db.execute<{
      student_id: string;
      absence_count: number;
      avg_latest: string | null;
      avg_previous: string | null;
      payment_late: boolean;
    }>(sql`
      WITH window_bounds AS (
        SELECT CURRENT_DATE - (${absenceWindow})::int AS window_start
      ),
      absence_counts AS (
        SELECT ast.student_id, COUNT(*)::int AS cnt
        FROM attendances_student ast
        CROSS JOIN window_bounds wb
        WHERE ast.status = 'absent'
          AND ast.date >= wb.window_start
        GROUP BY ast.student_id
      ),
      ranked_averages AS (
        SELECT spa.student_id, spa.average, gp.start_date,
               ROW_NUMBER() OVER (
                 PARTITION BY spa.student_id
                 ORDER BY gp.start_date DESC
               ) AS rn
        FROM student_period_averages spa
        INNER JOIN grading_periods gp ON gp.id = spa.grading_period_id
        INNER JOIN school_years sy ON sy.id = gp.school_year_id
        WHERE sy.status = 'active'
          AND spa.subject_id IS NULL
      )
      SELECT s.id::text AS student_id,
             COALESCE(ac.cnt, 0)::int AS absence_count,
             latest.average::text AS avg_latest,
             previous.average::text AS avg_previous,
             COALESCE((sfs.status = 'late'), false) AS payment_late
      FROM students_with_class s
      LEFT JOIN absence_counts ac ON ac.student_id = s.id
      LEFT JOIN LATERAL (
        SELECT ra.average FROM ranked_averages ra WHERE ra.student_id = s.id AND ra.rn = 1
      ) latest ON true
      LEFT JOIN LATERAL (
        SELECT ra.average FROM ranked_averages ra WHERE ra.student_id = s.id AND ra.rn = 2
      ) previous ON true
      LEFT JOIN student_financial_status sfs
        ON sfs.student_id = s.id
       AND sfs.school_year_id = (SELECT id FROM school_years WHERE status = 'active' LIMIT 1)
      WHERE s.is_active = true AND s.class_id IS NOT NULL
    `);

    const map = new Map<string, {
      absences: { count: number; active: boolean };
      grades: { drop: number | null; active: boolean };
      payments: boolean;
    }>();

    for (const row of getRows<{
      student_id: string;
      absence_count: number;
      avg_latest: string | null;
      avg_previous: string | null;
      payment_late: boolean;
    }>(result)) {
      const absenceCount = row.absence_count ?? 0;
      const latest = row.avg_latest !== null ? Number(row.avg_latest) : null;
      const previous = row.avg_previous !== null ? Number(row.avg_previous) : null;
      const drop =
        latest !== null && previous !== null
          ? Math.round((previous - latest) * 100) / 100
          : null;

      map.set(row.student_id, {
        absences: {
          count: absenceCount,
          active: isAbsenceRisk(
            absenceCount,
            absenceConfig.thresholdValue,
            absenceConfig.isActive
          ),
        },
        grades: {
          drop,
          active: isGradeDropRisk(drop, gradeConfig.thresholdValue, gradeConfig.isActive),
        },
        payments: isPaymentRisk(row.payment_late, paymentConfig.isActive),
      });
    }
    return map;
  }

  /** Absences profs sur la fenêtre glissante (adaptation serveur du calcul remplacé). */
  async computeTeacherAbsenceCounts(periodDays: number): Promise<Map<string, number>> {
    const result = await this.db.execute<{ teacher_id: string; cnt: number }>(sql`
      SELECT at.teacher_id::text, COUNT(*)::int AS cnt
      FROM attendances_teacher at
      WHERE at.status = 'absent'
        AND at.date >= CURRENT_DATE - (${periodDays})::int
      GROUP BY at.teacher_id
    `);
    const map = new Map<string, number>();
    for (const row of getRows<{ teacher_id: string; cnt: number }>(result)) {
      map.set(row.teacher_id, row.cnt);
    }
    return map;
  }

  async listStudentIds(): Promise<string[]> {
    const result = await this.db.execute<{ id: string }>(sql`
      SELECT id::text FROM students_with_class WHERE is_active = true AND class_id IS NOT NULL
    `);
    return getRows<{ id: string }>(result).map((row) => row.id);
  }

  async listTeacherIds(): Promise<string[]> {
    const result = await this.db.execute<{ id: string }>(sql`
      SELECT t.id::text FROM teachers t
      INNER JOIN users u ON u.id = t.user_id
      WHERE u.is_active = true
    `);
    return getRows<{ id: string }>(result).map((row) => row.id);
  }

  async upsertStudentRisk(input: {
    studentId: string;
    absencesSignal: boolean;
    gradesSignal: boolean;
    paymentSignal: boolean;
    riskScore: number;
    level: 'none' | 'attention' | 'warning' | 'critical';
  }): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO student_risk_status (
        student_id, absences_signal, grades_signal, payment_signal, risk_score, level, computed_at
      ) VALUES (
        ${input.studentId}::uuid, ${input.absencesSignal}, ${input.gradesSignal},
        ${input.paymentSignal}, ${input.riskScore}, ${input.level}::risk_level, NOW()
      )
      ON CONFLICT ("student_id") DO UPDATE SET
        absences_signal = EXCLUDED.absences_signal,
        grades_signal = EXCLUDED.grades_signal,
        payment_signal = EXCLUDED.payment_signal,
        risk_score = EXCLUDED.risk_score,
        level = EXCLUDED.level,
        computed_at = NOW()
    `);
  }

  async upsertTeacherRisk(input: {
    teacherId: string;
    absencesSignal: boolean;
    riskScore: number;
    level: 'none' | 'attention' | 'warning' | 'critical';
  }): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO teacher_risk_status (
        teacher_id, absences_signal, risk_score, level, computed_at
      ) VALUES (
        ${input.teacherId}::uuid, ${input.absencesSignal}, ${input.riskScore}, ${input.level}::risk_level, NOW()
      )
      ON CONFLICT ("teacher_id") DO UPDATE SET
        absences_signal = EXCLUDED.absences_signal,
        risk_score = EXCLUDED.risk_score,
        level = EXCLUDED.level,
        computed_at = NOW()
    `);
  }

  async listStudentRisks(input: StudentRiskListInput): Promise<{ rows: StudentRiskRow[]; total: number }> {
    const offset = (input.page - 1) * input.limit;
    const score = input.includePayments
      ? sql`srs.risk_score`
      : sql`(CASE WHEN srs.absences_signal THEN 1 ELSE 0 END + CASE WHEN srs.grades_signal THEN 1 ELSE 0 END)`;
    const riskLevel = sql`CASE
      WHEN ${score} <= 0 THEN 'none'::risk_level
      WHEN ${score} = 1 THEN 'attention'::risk_level
      WHEN ${score} = 2 THEN 'warning'::risk_level
      ELSE 'critical'::risk_level
    END`;
    const categoryCondition = input.category === 'absences'
      ? sql`srs.absences_signal`
      : input.category === 'grades'
        ? sql`srs.grades_signal`
        : input.category === 'payments'
          ? input.includePayments ? sql`srs.payment_signal` : sql`FALSE`
          : sql`TRUE`;
    const studentScope = input.studentIds
      ? input.studentIds.length > 0
        ? sql`s.id IN (${sql.join(input.studentIds.map((studentId) => sql`${studentId}::uuid`), sql`, `)})`
        : sql`FALSE`
      : sql`TRUE`;
    const conditions = sql`
      s.is_active = true
      AND (${input.schoolLevelId ?? null}::uuid IS NULL OR c.level_id = ${input.schoolLevelId ?? null}::uuid)
      AND (${input.classId ?? null}::uuid IS NULL OR c.id = ${input.classId ?? null}::uuid)
      AND ${studentScope}
      AND (${input.atRisk} = false OR ${score} > 0)
      AND ${categoryCondition}
      AND (${input.riskLevel ?? null}::text IS NULL OR ${riskLevel}::text = ${input.riskLevel ?? null})
    `;
    const [itemsResult, totalResult] = await Promise.all([
      this.db.execute<StudentRiskRow>(sql`
        SELECT srs.student_id::text,
               concat_ws(' ', s.first_name, s.last_name) AS student_name,
               l.id::text AS school_level_id,
               l.name AS school_level_name,
               c.id::text AS class_id,
               c.name AS class_name,
               srs.absences_signal,
               srs.grades_signal,
               ${input.includePayments ? sql`srs.payment_signal` : sql`FALSE`} AS payment_signal,
               ${score}::int AS risk_score,
               ${riskLevel}::text AS level,
               srs.computed_at::text
        FROM student_risk_status srs
        INNER JOIN students_with_class s ON s.id = srs.student_id
        LEFT JOIN classes c ON c.id = s.class_id
        LEFT JOIN levels l ON l.id = c.level_id
        WHERE ${conditions}
        ORDER BY ${score} DESC, student_name ASC
        LIMIT ${input.limit}
        OFFSET ${offset}
      `),
      this.db.execute<{ total: string | number }>(sql`
        SELECT COUNT(*) AS total
        FROM student_risk_status srs
        INNER JOIN students_with_class s ON s.id = srs.student_id
        LEFT JOIN classes c ON c.id = s.class_id
        LEFT JOIN levels l ON l.id = c.level_id
        WHERE ${conditions}
      `),
    ]);
    return {
      rows: getRows<StudentRiskRow>(itemsResult),
      total: Number(getRows<{ total: string | number }>(totalResult)[0]?.total ?? 0),
    };
  }

  async listTeacherRisks(input: TeacherRiskListInput): Promise<{ rows: TeacherRiskRow[]; total: number }> {
    const offset = (input.page - 1) * input.limit;
    const teacherAbsenceRule = (await this.listRules()).find(
      (rule) => rule.subjectType === 'teacher' && rule.signalType === 'absences'
    );
    const ruleConfig = resolveRollingRiskRule(
      teacherAbsenceRule,
      DEFAULT_RISK_RULES.teacherAbsences
    );
    const startDate = input.month ? `${input.month}-01` : null;
    const dateRange = input.month
      ? sql`at.date >= ${startDate}::date AND at.date < (${startDate}::date + INTERVAL '1 month')`
      : sql`at.date >= CURRENT_DATE - (${ruleConfig.periodDays})::int`;
    const teacherCounts = sql`
      SELECT t.id::text AS teacher_id,
             u.name AS teacher_name,
             COUNT(at.id) FILTER (WHERE at.status = 'absent')::int AS absence_count,
             CASE WHEN COUNT(at.id) > 0
                  THEN ROUND(100.0 * (COUNT(at.id) - COUNT(at.id) FILTER (WHERE at.status = 'absent')) / COUNT(at.id))::int
                  ELSE 100 END AS attendance_rate
      FROM teachers t
      INNER JOIN users u ON u.id = t.user_id AND u.is_active = true
      LEFT JOIN attendances_teacher at ON at.teacher_id = t.id AND ${dateRange}
      GROUP BY t.id, u.name
    `;
    const isAtRisk = sql`${ruleConfig.isActive} AND absence_count >= ${ruleConfig.thresholdValue}`;
    const [itemsResult, totalResult] = await Promise.all([
      this.db.execute<TeacherRiskRow>(sql`
        WITH teacher_counts AS (${teacherCounts})
        SELECT teacher_id,
               teacher_name,
               absence_count,
               attendance_rate,
               ${isAtRisk} AS absences_signal,
               CASE WHEN ${isAtRisk} THEN 1 ELSE 0 END::int AS risk_score,
               CASE WHEN ${isAtRisk} THEN 'attention' ELSE 'none' END AS level
        FROM teacher_counts
        WHERE (${input.atRisk} = false OR ${isAtRisk})
        ORDER BY ${isAtRisk} DESC, absence_count DESC, teacher_name ASC
        LIMIT ${input.limit}
        OFFSET ${offset}
      `),
      this.db.execute<{ total: string | number }>(sql`
        WITH teacher_counts AS (${teacherCounts})
        SELECT COUNT(*) AS total
        FROM teacher_counts
        WHERE (${input.atRisk} = false OR ${isAtRisk})
      `),
    ]);
    return {
      rows: getRows<TeacherRiskRow>(itemsResult),
      total: Number(getRows<{ total: string | number }>(totalResult)[0]?.total ?? 0),
    };
  }

  /** Classes dont le prof principal est l'utilisateur donné. */
  async listHomeroomStudentIds(userId: string): Promise<string[] | null> {
    const result = await this.db.execute<{ count: number }>(sql`
      SELECT COUNT(DISTINCT s.id)::int AS count
      FROM classes c
      INNER JOIN teachers t ON t.id = c.homeroom_teacher_id
      LEFT JOIN students_with_class s ON s.class_id = c.id AND s.is_active = true
      WHERE t.user_id = ${userId}::uuid
    `);
    const count = getRows<{ count: number }>(result)[0]?.count ?? 0;
    if (count === 0) return null;
    const rows = await this.db.execute<{ student_id: string }>(sql`
      SELECT DISTINCT s.id::text AS student_id
      FROM classes c
      INNER JOIN teachers t ON t.id = c.homeroom_teacher_id
      INNER JOIN students_with_class s ON s.class_id = c.id AND s.is_active = true
      WHERE t.user_id = ${userId}::uuid
    `);
    return getRows<{ student_id: string }>(rows).map((row) => row.student_id);
  }
}
