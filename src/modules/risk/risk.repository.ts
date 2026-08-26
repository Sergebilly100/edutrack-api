import { sql } from 'drizzle-orm';

import type { TenantDb } from '../../shared/database/db.js';

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
    void paymentRule;

    const absenceWindow = absenceRule?.periodDays && absenceRule.periodDays > 0 ? absenceRule.periodDays : 30;

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
      FROM students s
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
      WHERE s.is_active = true
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
      const absenceThreshold = absenceRule?.thresholdValue ?? 3;
      const latest = row.avg_latest !== null ? Number(row.avg_latest) : null;
      const previous = row.avg_previous !== null ? Number(row.avg_previous) : null;
      const drop =
        latest !== null && previous !== null
          ? Math.round((previous - latest) * 100) / 100
          : null;
      const gradesThreshold = gradeRule?.thresholdValue ?? 2;

      map.set(row.student_id, {
        absences: {
          count: absenceCount,
          active: absenceRule?.isActive !== false && absenceCount >= absenceThreshold,
        },
        grades: {
          drop,
          active:
            gradeRule?.isActive !== false &&
            drop !== null &&
            Math.abs(drop) >= gradesThreshold,
        },
        payments: row.payment_late,
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
      SELECT id::text FROM students WHERE is_active = true
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

  async listStudentRisks() {
    const result = await this.db.execute<Record<string, string | number | boolean>>(sql`
      SELECT srs.student_id::text,
             concat_ws(' ', s.first_name, s.last_name) AS student_name,
             c.name AS class_name,
             srs.absences_signal, srs.grades_signal, srs.payment_signal,
             srs.risk_score, srs.level::text, srs.computed_at::text
      FROM student_risk_status srs
      INNER JOIN students s ON s.id = srs.student_id AND s.is_active = true
      LEFT JOIN classes c ON c.id = s.class_id
      ORDER BY srs.risk_score DESC, student_name ASC
    `);
    return getRows(result);
  }

  async listTeacherRisks() {
    const result = await this.db.execute<Record<string, string | number | boolean>>(sql`
      SELECT trs.teacher_id::text,
             u.name AS teacher_name,
             COUNT(at.id) FILTER (WHERE at.status = 'absent' AND at.date >= CURRENT_DATE - 30)::int AS absence_count,
             CASE WHEN COALESCE(COUNT(at.id), 0) > 0
                  THEN ROUND(100.0 * (COUNT(at.id) - COUNT(at.id) FILTER (WHERE at.status = 'absent')) / COUNT(at.id))::int
                  ELSE 100 END AS attendance_rate,
             trs.absences_signal, trs.risk_score, trs.level::text
      FROM teacher_risk_status trs
      INNER JOIN teachers t ON t.id = trs.teacher_id
      INNER JOIN users u ON u.id = t.user_id AND u.is_active = true
      LEFT JOIN attendances_teacher at ON at.teacher_id = trs.teacher_id AND at.date >= CURRENT_DATE - 30
      GROUP BY trs.teacher_id, u.name, trs.absences_signal, trs.risk_score, trs.level
      ORDER BY trs.risk_score DESC, absence_count DESC, teacher_name ASC
    `);
    return getRows(result);
  }

  /** Classes dont le prof principal est l'utilisateur donné. */
  async listHomeroomStudentIds(userId: string): Promise<string[] | null> {
    const result = await this.db.execute<{ count: number }>(sql`
      SELECT COUNT(DISTINCT s.id)::int AS count
      FROM classes c
      INNER JOIN teachers t ON t.id = c.homeroom_teacher_id
      LEFT JOIN students s ON s.class_id = c.id AND s.is_active = true
      WHERE t.user_id = ${userId}::uuid
    `);
    const count = getRows<{ count: number }>(result)[0]?.count ?? 0;
    if (count === 0) return null;
    const rows = await this.db.execute<{ student_id: string }>(sql`
      SELECT DISTINCT s.id::text AS student_id
      FROM classes c
      INNER JOIN teachers t ON t.id = c.homeroom_teacher_id
      INNER JOIN students s ON s.class_id = c.id AND s.is_active = true
      WHERE t.user_id = ${userId}::uuid
    `);
    return getRows<{ student_id: string }>(rows).map((row) => row.student_id);
  }
}
