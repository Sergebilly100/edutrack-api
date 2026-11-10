import { sql } from 'drizzle-orm';
import { confirmedSchoolStudent } from '../../shared/database/confirmed-school-membership.js';
import { studentGradeRiskCtes } from '../../shared/database/student-grade-risk-query.js';

import type { TenantDb } from '../../shared/database/db.js';
import {
  DEFAULT_RISK_RULES,
  isAbsenceRisk,
  isPaymentRisk,
  resolveRiskRule,
  resolveRollingRiskRule,
  TEACHER_LATENESS_PERIOD_DAYS,
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
  lateMinutes?: number | null;
};

export type StudentRiskListInput = {
  page: number;
  limit: number;
  schoolYearId?: string;
  gradingPeriodId?: string;
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
  signal?: 'absences' | 'lateness';
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
  lateness_count: number;
  attendance_rate: number;
  absences_signal: boolean;
  lateness_signal: boolean;
  risk_score: number;
  level: 'none' | 'attention' | 'warning';
};

export class RiskRepository {
  constructor(readonly db: TenantDb) {}

  async listRules(): Promise<RiskRule[]> {
    const result = await this.db.execute<{
      id: string; subject_type: string; signal_type: string;
      threshold_value: string; period_days: number; is_active: boolean; late_minutes: number | null;
    }>(sql`
      SELECT id::text, subject_type, signal_type, threshold_value::text, period_days, is_active, late_minutes
      FROM risk_alert_rules ORDER BY subject_type, signal_type
    `);
    return getRows<{
      id: string; subject_type: string; signal_type: string;
      threshold_value: string; period_days: number; is_active: boolean; late_minutes: number | null;
    }>(result).map((row) => ({
      id: row.id,
      subjectType: row.subject_type as RiskRule['subjectType'],
      signalType: row.signal_type,
      thresholdValue: Number(row.threshold_value),
      periodDays: row.period_days,
      isActive: row.is_active,
      lateMinutes: row.late_minutes,
    }));
  }

  async upsertRule(input: {
    subjectType: 'student' | 'teacher';
    signalType: string;
    thresholdValue: number;
    periodDays: number;
    isActive: boolean;
    lateMinutes?: number | null;
  }): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO risk_alert_rules (subject_type, signal_type, threshold_value, period_days, is_active, late_minutes)
      VALUES (${input.subjectType}, ${input.signalType}, ${input.thresholdValue}, ${input.periodDays}, ${input.isActive}, ${input.lateMinutes ?? null})
      ON CONFLICT ("subject_type", "signal_type") DO UPDATE SET
        threshold_value = EXCLUDED.threshold_value,
        period_days = EXCLUDED.period_days,
        is_active = EXCLUDED.is_active,
        late_minutes = EXCLUDED.late_minutes,
        updated_at = NOW()
    `);
  }

  /**
   * Signaux élève en une requête : absences non justifiées sur la fenêtre,
   * baisse de moyenne générale sur la période sélectionnée et la précédente,
   * uniquement si les deux périodes sont clôturées,
   * statut de paiement depuis le cache financier (6a).
   */
  async computeStudentSignals(): Promise<Map<string, {
    absences: { count: number; active: boolean };
    grades: { active: boolean };
    payments: boolean;
  }>> {
    // Fenêtre et seuils par défaut (surchargés par les règles actives).
    const rules = await this.listRules();
    const absenceRule = rules.find((r) => r.subjectType === 'student' && r.signalType === 'absences');
    const paymentRule = rules.find((r) => r.subjectType === 'student' && r.signalType === 'payments');
    const absenceConfig = resolveRollingRiskRule(absenceRule, DEFAULT_RISK_RULES.studentAbsences);
    const paymentConfig = resolveRiskRule(paymentRule, DEFAULT_RISK_RULES.studentPayments);

    const absenceWindow = absenceConfig.periodDays;
    const activeSchoolYearId = sql`(
      SELECT id FROM school_years WHERE status = 'active' ORDER BY start_date DESC LIMIT 1
    )`;
    const gradeRiskCtes = studentGradeRiskCtes({ schoolYearId: activeSchoolYearId });

    const result = await this.db.execute<{
      student_id: string;
      absence_count: number;
      grades_signal: boolean;
      payment_late: boolean;
    }>(sql`
      WITH ${gradeRiskCtes},
      window_bounds AS (
        SELECT CURRENT_DATE - (${absenceWindow})::int AS window_start
      ),
      absence_counts AS (
        SELECT ast.student_id, COUNT(*)::int AS cnt
        FROM attendances_student ast
        INNER JOIN schedules sch ON sch.id = ast.schedule_id
        INNER JOIN classes absence_class ON absence_class.id = sch.class_id
        CROSS JOIN window_bounds wb
        WHERE ast.status = 'absent'
          AND ast.date >= wb.window_start
          AND ${confirmedSchoolStudent(sql`ast.student_id`, sql`absence_class.school_year_id`, sql`absence_class.id`)}
        GROUP BY ast.student_id
      )
      SELECT s.id::text AS student_id,
             COALESCE(ac.cnt, 0)::int AS absence_count,
             COALESCE(grade_risk.grades_signal, false) AS grades_signal,
             COALESCE((sfs.status = 'late'), false) AS payment_late
      FROM students s
      LEFT JOIN absence_counts ac ON ac.student_id = s.id
      LEFT JOIN student_grade_risks grade_risk ON grade_risk.student_id = s.id
      LEFT JOIN student_financial_status sfs
        ON sfs.student_id = s.id
       AND sfs.school_year_id = ${activeSchoolYearId}
      WHERE ${confirmedSchoolStudent(sql`s.id`, activeSchoolYearId)}
    `);

    const map = new Map<string, {
      absences: { count: number; active: boolean };
      grades: { active: boolean };
      payments: boolean;
    }>();

    for (const row of getRows<{
      student_id: string;
      absence_count: number;
      grades_signal: boolean;
      payment_late: boolean;
    }>(result)) {
      const absenceCount = row.absence_count ?? 0;

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
          active: row.grades_signal,
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

  async computeTeacherLatenessCounts(): Promise<Map<string, number>> {
    const result = await this.db.execute<{ teacher_id: string; cnt: number }>(sql`
      SELECT teacher_id::text, COUNT(*)::int AS cnt FROM attendances_teacher
      WHERE status = 'late'
        AND date BETWEEN CURRENT_DATE - (${TEACHER_LATENESS_PERIOD_DAYS - 1})::int AND CURRENT_DATE
      GROUP BY teacher_id
    `);
    return new Map(getRows<{ teacher_id: string; cnt: number }>(result).map((row) => [row.teacher_id, Number(row.cnt)]));
  }

  async listStudentIds(): Promise<string[]> {
    const result = await this.db.execute<{ id: string }>(sql`
      SELECT s.id::text FROM students s
      WHERE ${confirmedSchoolStudent(sql`s.id`, sql`(SELECT id FROM school_years WHERE status = 'active' LIMIT 1)`)}
    `);
    return getRows<{ id: string }>(result).map((row) => row.id);
  }

  async listTeacherIds(): Promise<string[]> {
    const result = await this.db.execute<{ id: string }>(sql`
      SELECT t.id::text FROM teachers t
      INNER JOIN users u ON u.id = t.user_id
      WHERE u.is_active = true AND t.is_blocked = false
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
    latenessSignal: boolean;
    riskScore: number;
    level: 'none' | 'attention' | 'warning' | 'critical';
  }): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO teacher_risk_status (
        teacher_id, absences_signal, lateness_signal, risk_score, level, computed_at
      ) VALUES (
        ${input.teacherId}::uuid, ${input.absencesSignal}, ${input.latenessSignal}, ${input.riskScore}, ${input.level}::risk_level, NOW()
      )
      ON CONFLICT ("teacher_id") DO UPDATE SET
        absences_signal = EXCLUDED.absences_signal,
        lateness_signal = EXCLUDED.lateness_signal,
        risk_score = EXCLUDED.risk_score,
        level = EXCLUDED.level,
        computed_at = NOW()
    `);
  }

  async listStudentRisks(input: StudentRiskListInput): Promise<{ rows: StudentRiskRow[]; total: number }> {
    const offset = (input.page - 1) * input.limit;
    const schoolYearId = sql`COALESCE(
      ${input.schoolYearId ?? null}::uuid,
      (SELECT id FROM school_years WHERE status = 'active' ORDER BY start_date DESC LIMIT 1)
    )`;
    const gradeRiskCtes = studentGradeRiskCtes({
      schoolYearId,
      gradingPeriodId: input.gradingPeriodId,
    });
    const score = sql`(CASE WHEN srs.absences_signal THEN 1 ELSE 0 END
      + CASE WHEN COALESCE(grade_risk.grades_signal, false) THEN 1 ELSE 0 END
      + CASE WHEN ${input.includePayments} AND srs.payment_signal THEN 1 ELSE 0 END)`;
    const riskLevel = sql`CASE
      WHEN ${score} = 0 THEN 'none'
      WHEN ${score} = 1 THEN 'attention'
      WHEN ${score} = 2 THEN 'warning'
      ELSE 'critical'
    END`;
    const categoryCondition = input.category === 'absences'
      ? sql`scoped.absences_signal`
      : input.category === 'grades'
        ? sql`scoped.grades_signal`
        : input.category === 'payments'
          ? input.includePayments ? sql`scoped.payment_signal` : sql`FALSE`
          : sql`TRUE`;
    const studentScope = input.studentIds
      ? input.studentIds.length > 0
        ? sql`scoped.student_id IN (${sql.join(input.studentIds.map((studentId) => sql`${studentId}::uuid`), sql`, `)})`
        : sql`FALSE`
      : sql`TRUE`;
    const conditions = sql`
      (${input.schoolLevelId ?? null}::uuid IS NULL OR scoped.school_level_id = ${input.schoolLevelId ?? null}::uuid)
      AND (${input.classId ?? null}::uuid IS NULL OR scoped.class_id = ${input.classId ?? null}::uuid)
      AND ${studentScope}
      AND (${input.atRisk} = false OR scoped.risk_score > 0)
      AND ${categoryCondition}
      AND (${input.riskLevel ?? null}::text IS NULL OR scoped.level = ${input.riskLevel ?? null}::text)
    `;
    const [itemsResult, totalResult] = await Promise.all([
      this.db.execute<StudentRiskRow>(sql`
        WITH ${gradeRiskCtes},
        scoped_student_risks AS (
          SELECT srs.student_id,
                 format_person_name(s.first_name, s.last_name) AS student_name,
                 l.id AS school_level_id,
                 l.name AS school_level_name,
                 c.id AS class_id,
                 c.name AS class_name,
                 srs.absences_signal,
                 COALESCE(grade_risk.grades_signal, false) AS grades_signal,
                 srs.payment_signal,
                 ${score}::int AS risk_score,
                 ${riskLevel}::text AS level,
                 srs.computed_at
          FROM student_risk_status srs
          INNER JOIN students s ON s.id = srs.student_id AND s.is_active = true
          INNER JOIN classes c ON c.is_active = true AND c.school_year_id = ${schoolYearId}
            AND ${confirmedSchoolStudent(sql`s.id`, sql`c.school_year_id`, sql`c.id`)}
          LEFT JOIN levels l ON l.id = c.level_id
          LEFT JOIN student_grade_risks grade_risk ON grade_risk.student_id = s.id
        )
        SELECT scoped.student_id::text,
               scoped.student_name,
               scoped.school_level_id::text,
               scoped.school_level_name,
               scoped.class_id::text,
               scoped.class_name,
               scoped.absences_signal,
               scoped.grades_signal,
               ${input.includePayments ? sql`scoped.payment_signal` : sql`FALSE`} AS payment_signal,
               scoped.risk_score,
               scoped.level,
               scoped.computed_at::text
        FROM scoped_student_risks scoped
        WHERE ${conditions}
        ORDER BY scoped.risk_score DESC, scoped.student_name ASC
        LIMIT ${input.limit}
        OFFSET ${offset}
      `),
      this.db.execute<{ total: string | number }>(sql`
        WITH ${gradeRiskCtes},
        scoped_student_risks AS (
          SELECT srs.student_id,
                 l.id AS school_level_id,
                 c.id AS class_id,
                 srs.absences_signal,
                 COALESCE(grade_risk.grades_signal, false) AS grades_signal,
                 srs.payment_signal,
                 ${score}::int AS risk_score,
                 ${riskLevel}::text AS level
          FROM student_risk_status srs
          INNER JOIN students s ON s.id = srs.student_id AND s.is_active = true
          INNER JOIN classes c ON c.is_active = true AND c.school_year_id = ${schoolYearId}
            AND ${confirmedSchoolStudent(sql`s.id`, sql`c.school_year_id`, sql`c.id`)}
          LEFT JOIN levels l ON l.id = c.level_id
          LEFT JOIN student_grade_risks grade_risk ON grade_risk.student_id = s.id
        )
        SELECT COUNT(*) AS total
        FROM scoped_student_risks scoped
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
    const rules = await this.listRules();
    const latenessRule = rules.find((rule) => rule.subjectType === 'teacher' && rule.signalType === 'lateness');
    const teacherAbsenceRule = rules.find(
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
    const latenessRange = input.month ? dateRange
      : sql`at.date BETWEEN CURRENT_DATE - (${TEACHER_LATENESS_PERIOD_DAYS - 1})::int AND CURRENT_DATE`;
    const latenessCounts = sql`
      SELECT at.teacher_id, COUNT(*)::int AS cnt FROM attendances_teacher at
      WHERE at.status = 'late' AND ${latenessRange} GROUP BY at.teacher_id
    `;
    const teacherCounts = sql`
      SELECT t.id::text AS teacher_id,
             u.name AS teacher_name,
             COUNT(at.id) FILTER (WHERE at.status = 'absent')::int AS absence_count,
             COALESCE(lc.cnt, 0)::int AS lateness_count,
             CASE WHEN COUNT(at.id) > 0
                  THEN ROUND(100.0 * (COUNT(at.id) - COUNT(at.id) FILTER (WHERE at.status = 'absent')) / COUNT(at.id))::int
                  ELSE 100 END AS attendance_rate
      FROM teachers t
      INNER JOIN users u ON u.id = t.user_id AND u.is_active = true
      LEFT JOIN attendances_teacher at ON at.teacher_id = t.id AND ${dateRange}
      LEFT JOIN (${latenessCounts}) lc ON lc.teacher_id = t.id
      WHERE t.is_blocked = false
      GROUP BY t.id, u.name, lc.cnt
    `;
    const absenceSignal = sql`(${ruleConfig.isActive} AND absence_count >= ${ruleConfig.thresholdValue})`;
    const latenessSignal = latenessRule
      ? sql`(${latenessRule.isActive} AND lateness_count >= ${latenessRule.thresholdValue})` : sql`FALSE`;
    const score = sql`(CASE WHEN ${absenceSignal} THEN 1 ELSE 0 END + CASE WHEN ${latenessSignal} THEN 1 ELSE 0 END)`;
    const isAtRisk = sql`(${absenceSignal} OR ${latenessSignal})`;
    // Filtre par motif (lien depuis le tableau de bord) : même définition que les signaux ci-dessus.
    const signalFilter = input.signal === 'absences' ? absenceSignal : input.signal === 'lateness' ? latenessSignal : sql`TRUE`;
    const [itemsResult, totalResult] = await Promise.all([
      this.db.execute<TeacherRiskRow>(sql`
        WITH teacher_counts AS (${teacherCounts})
        SELECT teacher_id,
               teacher_name,
               absence_count,
               lateness_count,
               attendance_rate,
               ${absenceSignal} AS absences_signal,
               ${latenessSignal} AS lateness_signal,
               ${score}::int AS risk_score,
               CASE WHEN ${score} = 2 THEN 'warning' WHEN ${score} = 1 THEN 'attention' ELSE 'none' END AS level
        FROM teacher_counts
        WHERE (${input.atRisk} = false OR ${isAtRisk}) AND ${signalFilter}
        ORDER BY ${score} DESC, absence_count DESC, lateness_count DESC, teacher_name ASC
        LIMIT ${input.limit}
        OFFSET ${offset}
      `),
      this.db.execute<{ total: string | number }>(sql`
        WITH teacher_counts AS (${teacherCounts})
        SELECT COUNT(*) AS total
        FROM teacher_counts
        WHERE (${input.atRisk} = false OR ${isAtRisk}) AND ${signalFilter}
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
      INNER JOIN school_years sy ON sy.id = c.school_year_id AND sy.status = 'active'
      LEFT JOIN students s ON ${confirmedSchoolStudent(sql`s.id`, sql`c.school_year_id`, sql`c.id`)}
      WHERE t.user_id = ${userId}::uuid AND c.is_active = true
    `);
    const count = getRows<{ count: number }>(result)[0]?.count ?? 0;
    if (count === 0) return null;
    const rows = await this.db.execute<{ student_id: string }>(sql`
      SELECT DISTINCT s.id::text AS student_id
      FROM classes c
      INNER JOIN teachers t ON t.id = c.homeroom_teacher_id
      INNER JOIN school_years sy ON sy.id = c.school_year_id AND sy.status = 'active'
      INNER JOIN students s ON ${confirmedSchoolStudent(sql`s.id`, sql`c.school_year_id`, sql`c.id`)}
      WHERE t.user_id = ${userId}::uuid AND c.is_active = true
    `);
    return getRows<{ student_id: string }>(rows).map((row) => row.student_id);
  }
}
