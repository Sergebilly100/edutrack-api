import type { TenantDb } from '../../shared/database/db.js';
import { sql } from 'drizzle-orm';

const monthToBounds = (month: string): { monthStart: string; monthEnd: string } => {
  const [yearRaw, monthRaw] = month.split('-');
  const year = Number(yearRaw);
  const monthNumber = Number(monthRaw);

  if (!Number.isInteger(year) || !Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
    throw new Error('Invalid month format');
  }

  const monthStart = `${yearRaw}-${monthRaw}-01`;
  const monthEnd = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  return { monthStart, monthEnd };
};

const minIsoDate = (a: string, b: string): string => (a <= b ? a : b);
const maxIsoDate = (a: string, b: string): string => (a >= b ? a : b);

export function buildDashboardRepository(db: TenantDb) {
  /**
   * Calcule le taux de présence professeurs pour le jour donné
   * Les attendus viennent de l'EDT actif du jour, pas des seuls pointages existants.
   * Retourne les stats globales + détail vacataires/permanents
   */
  async function getTeacherAttendanceForDay(date: string) {
    const result = await db.execute<{
      teacher_type: 'vacataire' | 'permanent';
      expected: number;
      present: number;
    }>(sql`
      WITH active_period AS (
        SELECT id
        FROM schedule_periods
        WHERE is_active = true
          AND ${date}::date BETWEEN valid_from AND valid_to
        ORDER BY created_at DESC
        LIMIT 1
      ),
      expected_schedules AS (
        SELECT s.id AS schedule_id, t.type AS teacher_type
        FROM schedules s
        INNER JOIN active_period ap ON ap.id = s.schedule_period_id
        INNER JOIN teachers t ON t.id = s.teacher_id
        INNER JOIN users u ON u.id = t.user_id
        WHERE s.is_active = true
          AND u.is_active = true
          AND s.day_of_week = EXTRACT(ISODOW FROM ${date}::date)::int
          AND (s.start_date IS NULL OR s.start_date <= ${date}::date)
          AND (s.end_date IS NULL OR s.end_date > ${date}::date)
          AND NOT EXISTS (
            SELECT 1 FROM schedule_exceptions se
            WHERE se.schedule_id = s.id AND se.exception_date = ${date}::date
          )
      )
      SELECT
        es.teacher_type,
        COUNT(*)::int AS expected,
        COUNT(*) FILTER (WHERE at.status IN ('present', 'late', 'excused'))::int AS present
      FROM expected_schedules es
      LEFT JOIN attendances_teacher at
        ON at.schedule_id = es.schedule_id
       AND at.date = ${date}::date
      GROUP BY es.teacher_type
    `);

    const partTime = result.rows.find((row) => row.teacher_type === 'vacataire');
    const fullTime = result.rows.find((row) => row.teacher_type === 'permanent');
    const partTimeExpected = partTime?.expected ?? 0;
    const partTimePresent = partTime?.present ?? 0;
    const fullTimeExpected = fullTime?.expected ?? 0;
    const fullTimePresent = fullTime?.present ?? 0;

    const totalExpected = partTimeExpected + fullTimeExpected;
    const totalPresent = partTimePresent + fullTimePresent;

    return {
      globalRate: totalExpected > 0 ? (totalPresent / totalExpected) * 100 : 0,
      partTime: {
        rate: partTimeExpected > 0 ? (partTimePresent / partTimeExpected) * 100 : 0,
        present: partTimePresent,
        expected: partTimeExpected,
      },
      fullTime: {
        rate: fullTimeExpected > 0 ? (fullTimePresent / fullTimeExpected) * 100 : 0,
        present: fullTimePresent,
        expected: fullTimeExpected,
      },
    };
  }

  /**
   * Calcule le taux de présence professeurs sur les heures prévues du mois.
   * Mois passé : période complète. Mois courant : du 1er à la date courante.
   */
  async function getTeacherAttendanceForMonth(month: string, currentDate: string) {
    const { monthStart, monthEnd } = monthToBounds(month);
    const periodEnd = maxIsoDate(monthStart, minIsoDate(currentDate, monthEnd));
    const result = await db.execute<{
      teacher_type: 'vacataire' | 'permanent';
      planned_hours: string | number;
      completed_hours: string | number;
    }>(sql`
      WITH month_days AS (
        SELECT generate_series(${monthStart}::date, ${periodEnd}::date, interval '1 day')::date AS d
      ),
      active_period_by_day AS (
        SELECT md.d, sp.id AS period_id
        FROM month_days md
        LEFT JOIN LATERAL (
          SELECT id
          FROM schedule_periods
          WHERE is_active = true
            AND md.d BETWEEN valid_from AND valid_to
          ORDER BY created_at DESC
          LIMIT 1
        ) sp ON true
      ),
      expected_schedules AS (
        SELECT
          apd.d,
          s.id AS schedule_id,
          t.type AS teacher_type,
          (EXTRACT(EPOCH FROM (ts.end_time - ts.start_time)) / 3600.0) AS hours
        FROM active_period_by_day apd
        INNER JOIN schedules s
          ON s.schedule_period_id = apd.period_id
         AND s.is_active = true
         AND s.day_of_week = EXTRACT(ISODOW FROM apd.d)::int
         AND (s.start_date IS NULL OR s.start_date <= apd.d)
         AND (s.end_date IS NULL OR s.end_date > apd.d)
          AND NOT EXISTS (
            SELECT 1 FROM schedule_exceptions se
            WHERE se.schedule_id = s.id AND se.exception_date = apd.d
          )
        INNER JOIN teachers t ON t.id = s.teacher_id
        INNER JOIN users u ON u.id = t.user_id
        INNER JOIN time_slots ts ON ts.id = s.time_slot_id
        WHERE u.is_active = true
      )
      -- Heures effectuées : identiques à celles de l'Économie (getSalaryStatsForMonth)
      -- pour que les cartes "Taux de présence profs" et "Économie du mois" présentent
      -- le même nombre d'heures effectuées :
      --   - approved → validated_hours (peut être < heures prévues)
      --   - rejected → 0
      --   - present/late/excused (sans validation finalisée) → heures pleines du créneau
      SELECT
        es.teacher_type,
        COALESCE(SUM(es.hours), 0)::numeric(8,2) AS planned_hours,
        COALESCE(SUM(
          CASE
            WHEN at.validation_status = 'approved' THEN COALESCE(at.validated_hours, 0)
            WHEN at.validation_status = 'rejected' THEN 0
            WHEN at.status IN ('present', 'late', 'excused') THEN es.hours
            ELSE 0
          END
        ), 0)::numeric(8,2) AS completed_hours
      FROM expected_schedules es
      LEFT JOIN attendances_teacher at
        ON at.schedule_id = es.schedule_id
       AND at.date = es.d
      GROUP BY es.teacher_type
    `);

    const partTime = result.rows.find((row) => row.teacher_type === 'vacataire');
    const fullTime = result.rows.find((row) => row.teacher_type === 'permanent');
    const partTimeExpected = Number(partTime?.planned_hours ?? 0);
    const partTimePresent = Number(partTime?.completed_hours ?? 0);
    const fullTimeExpected = Number(fullTime?.planned_hours ?? 0);
    const fullTimePresent = Number(fullTime?.completed_hours ?? 0);
    const totalExpected = partTimeExpected + fullTimeExpected;
    const totalPresent = partTimePresent + fullTimePresent;

    return {
      globalRate: totalExpected > 0 ? (totalPresent / totalExpected) * 100 : 0,
      partTime: {
        rate: partTimeExpected > 0 ? (partTimePresent / partTimeExpected) * 100 : 0,
        present: partTimePresent,
        expected: partTimeExpected,
      },
      fullTime: {
        rate: fullTimeExpected > 0 ? (fullTimePresent / fullTimeExpected) * 100 : 0,
        present: fullTimePresent,
        expected: fullTimeExpected,
      },
    };
  }

  /**
   * Calcule le taux de présence élèves pour le jour donné
   * Les attendus correspondent aux appels élèves requis par les cours du jour.
   */
  async function getStudentAttendanceForDay(date: string) {
    const result = await db.execute<{
      total: number;
      present: number;
      absent: number;
      marked: number;
    }>(sql`
      WITH active_period AS (
        SELECT id
        FROM schedule_periods
        WHERE is_active = true
          AND ${date}::date BETWEEN valid_from AND valid_to
        ORDER BY created_at DESC
        LIMIT 1
      ),
      expected_rollcall AS (
        SELECT st.id AS student_id, s.id AS schedule_id
        FROM schedules s
        INNER JOIN active_period ap ON ap.id = s.schedule_period_id
        INNER JOIN students st ON st.class_id = s.class_id
        WHERE s.is_active = true
          AND st.is_active = true
          AND s.day_of_week = EXTRACT(ISODOW FROM ${date}::date)::int
          AND (s.start_date IS NULL OR s.start_date <= ${date}::date)
          AND (s.end_date IS NULL OR s.end_date > ${date}::date)
          AND NOT EXISTS (
            SELECT 1 FROM schedule_exceptions se
            WHERE se.schedule_id = s.id AND se.exception_date = ${date}::date
          )
      )
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE ast.status = 'present')::int AS present,
        COUNT(*) FILTER (WHERE ast.status = 'absent')::int AS absent,
        COUNT(ast.id)::int AS marked
      FROM expected_rollcall er
      LEFT JOIN attendances_student ast
        ON ast.student_id = er.student_id
       AND ast.schedule_id = er.schedule_id
       AND ast.date = ${date}::date
    `);
    const total = result.rows[0]?.total ?? 0;
    const present = result.rows[0]?.present ?? 0;
    const absent = result.rows[0]?.absent ?? 0;
    const marked = result.rows[0]?.marked ?? 0;

    if (total <= 0) {
      return {
        rate: 0,
        present: 0,
        absent: 0,
        notMarked: 0,
        total: 0,
      };
    }

    const notMarked = Math.max(0, total - marked);
    const rate = total > 0 ? (present / total) * 100 : 0;

    return {
      rate,
      present,
      absent,
      notMarked,
      total,
    };
  }

  /**
   * Calcule les stats salaires du mois en cours
   * - Total théorique du mois entier (tous créneaux EDT × taux horaire)
   * - Économie : heures prévues vs effectuées jusqu'à aujourd'hui
   */
  async function getSalaryStatsForMonth(month: string, currentDate: string) {
    const { monthStart, monthEnd } = monthToBounds(month);
    const periodEnd = maxIsoDate(monthStart, minIsoDate(currentDate, monthEnd));
    const salaryPaymentTotals = await getSalaryPaymentTotalsForMonth(monthStart);

    const partTimeTeachersResult = await db.execute<{
      id: string;
      hourly_rate: number | null;
    }>(sql`
      SELECT id::text AS id, hourly_rate
      FROM teachers
      WHERE type = 'vacataire'
    `);
    const partTimeTeachers = partTimeTeachersResult.rows;

    if (partTimeTeachers.length === 0) {
      const day = periodEnd.split('-')[2];
      const monthLabel = getMonthName(month);
      return {
        monthlyTotal: salaryPaymentTotals.totalPayroll,
        toPayCurrentPeriod: 0,
        totalPaid: salaryPaymentTotals.totalPaid,
        remainingToPay: salaryPaymentTotals.remainingToPay,
        economy: {
          label: `Du 1er au ${day} ${monthLabel}`,
          plannedHours: 0,
          completedHours: 0,
          savedAmount: 0,
        },
      };
    }

    const economyResult = await db.execute<{
      monthly_total_hours: string | number;
      planned_hours_until_period_end: string | number;
      completed_hours_until_period_end: string | number;
      attendance_monthly_total: string | number;
      to_pay_current_period: string | number;
      saved_amount: string | number;
    }>(sql`
      WITH month_days AS (
        SELECT generate_series(${monthStart}::date, ${monthEnd}::date, interval '1 day')::date AS d
      ),
      active_period_by_day AS (
        SELECT md.d, sp.id AS period_id
        FROM month_days md
        LEFT JOIN LATERAL (
          SELECT id
          FROM schedule_periods
          WHERE is_active = true
            AND md.d BETWEEN valid_from AND valid_to
          ORDER BY created_at DESC
          LIMIT 1
        ) sp ON true
      ),
      expected_schedules AS (
        SELECT
          apd.d,
          s.id AS schedule_id,
          s.teacher_id,
          (EXTRACT(EPOCH FROM (ts.end_time - ts.start_time)) / 3600.0) AS hours,
          COALESCE(t.hourly_rate, 0) AS hourly_rate
        FROM active_period_by_day apd
        INNER JOIN schedules s
          ON s.schedule_period_id = apd.period_id
         AND s.is_active = true
         AND s.day_of_week = EXTRACT(ISODOW FROM apd.d)::int
         AND (s.start_date IS NULL OR s.start_date <= apd.d)
         AND (s.end_date IS NULL OR s.end_date > apd.d)
         AND NOT EXISTS (
           SELECT 1 FROM schedule_exceptions se
           WHERE se.schedule_id = s.id AND se.exception_date = apd.d
         )
        INNER JOIN teachers t ON t.id = s.teacher_id
        INNER JOIN users u ON u.id = t.user_id
        INNER JOIN time_slots ts ON ts.id = s.time_slot_id
        WHERE t.type = 'vacataire'
          AND u.is_active = true
      )
      -- Heures réellement comptabilisées pour le paiement :
      --   - approved → validated_hours (peut être < hours prévues)
      --   - rejected → 0
      --   - present/late/excused (sans validation_status finale) → hours pleines
      -- Heures économisées par l'école = hours prévues - hours payées,
      -- ce qui inclut désormais la différence "approbation à heures réduites".
      SELECT
        COALESCE(SUM(es.hours), 0)::numeric(8,2) AS monthly_total_hours,
        COALESCE(SUM(es.hours) FILTER (WHERE es.d <= ${periodEnd}::date), 0)::numeric(8,2) AS planned_hours_until_period_end,
        COALESCE(SUM(
          CASE
            WHEN es.d > ${periodEnd}::date THEN 0
            WHEN at.validation_status = 'approved' THEN COALESCE(at.validated_hours, 0)
            WHEN at.validation_status = 'rejected' THEN 0
            WHEN at.status IN ('present', 'late', 'excused') THEN es.hours
            ELSE 0
          END
        ), 0)::numeric(8,2) AS completed_hours_until_period_end,
        COALESCE(SUM(es.hours * es.hourly_rate), 0)::numeric(12,2) AS attendance_monthly_total,
        COALESCE(SUM(
          CASE
            WHEN es.d > ${periodEnd}::date THEN 0
            WHEN at.validation_status = 'approved' THEN COALESCE(at.validated_hours, 0) * es.hourly_rate
            WHEN at.validation_status = 'rejected' THEN 0
            WHEN at.status IN ('present', 'late', 'excused') THEN es.hours * es.hourly_rate
            ELSE 0
          END
        ), 0)::numeric(12,2) AS to_pay_current_period,
        COALESCE(SUM(
          CASE
            WHEN es.d > ${periodEnd}::date THEN 0
            -- Approbation à heures réduites : la différence est une économie
            WHEN at.validation_status = 'approved'
              THEN GREATEST(0, es.hours - COALESCE(at.validated_hours, 0)) * es.hourly_rate
            -- Cours rejeté ou marqué absent : économie pleine
            WHEN at.validation_status = 'rejected' THEN es.hours * es.hourly_rate
            WHEN at.id IS NULL OR at.status = 'absent' THEN es.hours * es.hourly_rate
            ELSE 0
          END
        ), 0)::numeric(12,2) AS saved_amount
      FROM expected_schedules es
      LEFT JOIN attendances_teacher at
        ON at.schedule_id = es.schedule_id
       AND at.date = es.d
    `);
    const economyRow = economyResult.rows[0];
    const attendanceMonthlyTotal = Number(economyRow?.attendance_monthly_total ?? 0);
    const toPayCurrentPeriod = Number(economyRow?.to_pay_current_period ?? 0);
    const savedAmount = Number(economyRow?.saved_amount ?? 0);
    const monthlyTotal = salaryPaymentTotals.hasRecords
      ? salaryPaymentTotals.totalPayroll
      : attendanceMonthlyTotal;
    const remainingToPay = salaryPaymentTotals.hasRecords
      ? salaryPaymentTotals.remainingToPay
      : toPayCurrentPeriod;

    const day = periodEnd.split('-')[2];
    const monthLabel = getMonthName(month);

    return {
      monthlyTotal,
      toPayCurrentPeriod,
      totalPaid: salaryPaymentTotals.totalPaid,
      remainingToPay,
      economy: {
        label: `Du 1er au ${day} ${monthLabel}`,
        plannedHours: Number(economyRow?.planned_hours_until_period_end ?? 0),
        completedHours: Number(economyRow?.completed_hours_until_period_end ?? 0),
        savedAmount: Math.max(0, savedAmount),
      },
    };
  }

  async function getSalaryPaymentTotalsForMonth(monthStart: string) {
    const result = await db.execute<{
      record_id: string;
      total_fcfa: number;
      status: 'pending' | 'paid' | 'disputed';
      paid_amount: number;
    }>(sql`
      SELECT
        sr.id::text AS record_id,
        sr.total_fcfa::int AS total_fcfa,
        sr.status,
        COALESCE(SUM(sp.amount_fcfa), 0)::int AS paid_amount
      FROM salary_records sr
      LEFT JOIN salary_payments sp ON sp.salary_record_id = sr.id
      WHERE sr.period_month = ${monthStart}::date
      GROUP BY sr.id, sr.total_fcfa, sr.status
    `);
    const rows = result.rows;

    const totalPayroll = rows.reduce((sum, row) => sum + (row.total_fcfa ?? 0), 0);
    const totalPaid = rows.reduce((sum, row) => sum + Number(row.paid_amount ?? 0), 0);
    const remainingToPay = rows.reduce((sum, row) => {
      if (row.status === 'paid') {
        return sum;
      }
      return sum + Math.max(0, (row.total_fcfa ?? 0) - Number(row.paid_amount ?? 0));
    }, 0);

    return {
      hasRecords: rows.length > 0,
      totalPayroll,
      totalPaid,
      remainingToPay,
    };
  }

  /**
   * Calcule les stats abonnements parents du mois
   */
  async function getSubscriptionStatsForMonth(month: string) {
    const { monthStart, monthEnd } = monthToBounds(month);

    const activeSubs = await db.execute<{ active_subscribers: number; expected_amount: number }>(sql`
      SELECT
        COUNT(*)::int AS active_subscribers,
        COALESCE(SUM(total_amount_fcfa), 0)::int AS expected_amount
      FROM parent_subscriptions
      WHERE status <> 'cancelled'
        AND starts_at <= ${monthEnd}::date
        AND ends_at >= ${monthStart}::date
    `);
    const activeSubscribers = activeSubs.rows[0]?.active_subscribers ?? 0;
    const expectedAmount = activeSubs.rows[0]?.expected_amount ?? 0;

    const payments = await db.execute<{ collected_amount: number }>(sql`
      SELECT COALESCE(SUM(amount_fcfa), 0)::int AS collected_amount
      FROM subscription_payments
      WHERE paid_at >= ${monthStart}::timestamp
        AND paid_at < (${monthStart}::date + INTERVAL '1 month')::timestamp
    `);
    const collectedAmount = payments.rows[0]?.collected_amount ?? 0;

    const collectionRate = expectedAmount > 0 ? (collectedAmount / expectedAmount) * 100 : 0;

    return {
      isEnabled: await isSubscriptionRevenueEnabled(),
      collectedAmount,
      activeSubscribers,
      collectionRate,
      expectedAmount,
    };
  }

  async function isSubscriptionRevenueEnabled() {
    const result = await db.execute<{ is_enabled: boolean }>(sql`
      SELECT COALESCE(f.monetize_parent_alerts, false) AS is_enabled
      FROM public.tenants t
      LEFT JOIN public.school_sms_features f ON f.tenant_id = t.id
      WHERE t.schema_name = current_schema()
      LIMIT 1
    `);
    return result.rows[0]?.is_enabled ?? false;
  }

  return {
    getTeacherAttendanceForDay,
    getTeacherAttendanceForMonth,
    getStudentAttendanceForDay,
    getSalaryStatsForMonth,
    getSubscriptionStatsForMonth,
  };
}

function getMonthName(month: string): string {
  const monthNames = [
    'janvier',
    'février',
    'mars',
    'avril',
    'mai',
    'juin',
    'juillet',
    'août',
    'septembre',
    'octobre',
    'novembre',
    'décembre',
  ];
  const [, monthNum] = month.split('-');
  const index = parseInt(monthNum ?? '1', 10) - 1;
  return monthNames[index] ?? 'janvier';
}

export type DashboardRepository = ReturnType<typeof buildDashboardRepository>;
