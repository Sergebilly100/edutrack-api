import { BillingRepository, type SalaryRecordStatus } from './billing.repository.js';
import { emit } from '../../shared/events/event-bus.js';

export class BillingModuleError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message);
    this.name = 'BillingModuleError';
  }
}

const monthToBounds = (month: string): { monthStart: string; monthEnd: string } => {
  const [yearRaw, monthRaw] = month.split('-');
  const year = Number(yearRaw);
  const monthNumber = Number(monthRaw);

  if (!Number.isInteger(year) || !Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
    throw new BillingModuleError('Invalid month format', 400, 'INVALID_MONTH');
  }

  if (year < 2000 || year > 2100) {
    throw new BillingModuleError('Year out of valid range (2000-2100)', 400, 'INVALID_MONTH');
  }

  const monthStart = `${yearRaw}-${monthRaw}-01`;
  const endDate = new Date(Date.UTC(year, monthNumber, 0));
  const monthEnd = endDate.toISOString().slice(0, 10);
  return { monthStart, monthEnd };
};

const roundHours = (value: number): number => Math.round(value * 100) / 100;

type DailyBreakdownRow = {
  date: string;
  schedule_id: string;
  class_name: string;
  subject: string;
  day_of_week: number;
  slot_label: string;
  start_time: string;
  end_time: string;
  attendance_status: string | null;
  checked_in_at: string | null;
  room_scan_end_at: string | null;
  late_minutes: number | null;
  room_mismatch: boolean | null;
  has_rollcall: boolean | null;
  hours_planned: string | number;
  hours_done: string | number;
};

const buildDailyRows = (daily: DailyBreakdownRow[]) => {
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);
  const currentTime = now.toISOString().slice(11, 16);

  return daily.map((row) => {
    const hoursPlanned = BillingRepository.toNumber(row.hours_planned);
    const effectiveHoursDone = BillingRepository.toNumber(row.hours_done);
    const rowEndTime = row.end_time.slice(0, 5);
    const hasExplicitStatus = row.attendance_status !== null;
    const shouldAutoAbsent =
      !hasExplicitStatus &&
      (row.date < todayIso || (row.date === todayIso && rowEndTime < currentTime));
    const attendanceStatus = row.attendance_status ?? (shouldAutoAbsent ? 'absent' : 'not_marked');
    const countedAsDone =
      attendanceStatus === 'present' || attendanceStatus === 'late' || attendanceStatus === 'excused';
    const hasRollcall = row.has_rollcall === true;

    return {
      date: row.date,
      scheduleId: row.schedule_id,
      className: row.class_name,
      subject: row.subject,
      dayOfWeek: row.day_of_week,
      slotLabel: row.slot_label,
      startTime: row.start_time,
      endTime: row.end_time,
      attendanceStatus,
      checkedInAt: row.checked_in_at,
      checkedOutAt: row.room_scan_end_at,
      lateMinutes: row.late_minutes,
      roomMismatch: row.room_mismatch === true,
      rollcallDone: hasRollcall,
      rollcallMissing: !hasRollcall && row.checked_in_at !== null,
      hoursPlanned: roundHours(hoursPlanned),
      hoursDone: roundHours(countedAsDone ? effectiveHoursDone : 0),
    };
  });
};

const computeTeacherFinancials = (
  rows: ReturnType<typeof buildDailyRows>,
  teacher: { teacher_type: string; hourly_rate: number | null; monthly_salary: number | null },
  teacherMetrics: Record<string, unknown> | null | undefined,
  effectivePaidHours: number,
  effectivePaidAmount: number,
) => {
  const totals = rows.reduce(
    (acc, row) => {
      acc.hoursPlanned += row.hoursPlanned;
      acc.hoursDone += row.hoursDone;
      if (row.attendanceStatus === 'absent') {
        acc.absenceHours += row.hoursPlanned;
      }
      // Heures encore à venir = heures PLANIFIÉES des séances pas encore passées.
      // Une séance déjà passée (present/late/excused/absent) ne laisse aucune
      // heure restante, quelle que soit la durée réellement effectuée/validée :
      // un cours de 2h fait en 30 min reste un cours consommé (0h restante),
      // on ne soustrait donc pas les heures faites.
      if (row.attendanceStatus === 'not_marked') {
        acc.futurePlannedHours += row.hoursPlanned;
      }
      return acc;
    },
    { hoursPlanned: 0, hoursDone: 0, absenceHours: 0, futurePlannedHours: 0 }
  );

  const hourlyRate = teacher.hourly_rate;
  const totalFcfa =
    teacher.teacher_type === 'permanent'
      ? teacher.monthly_salary
      : hourlyRate === null
        ? null
        : Math.round(totals.hoursDone * hourlyRate);

  const remainingHoursToPay = Math.max(
    0,
    totals.hoursDone - (teacher.teacher_type === 'vacataire' ? effectivePaidHours : 0)
  );
  const hoursDoneSincePaid = teacherMetrics ? BillingRepository.toNumber(teacherMetrics.hours_done_since_paid as string | number) : 0;
  const hoursDoneSinceLastPayment =
    teacher.teacher_type === 'vacataire' && teacherMetrics?.paid_at
      ? roundHours(Math.max(0, hoursDoneSincePaid))
      : 0;
  const absenceHours = roundHours(totals.absenceHours);
  const remainingPlannedHours = roundHours(Math.max(0, totals.futurePlannedHours));
  const currentEarnedAmount =
    teacher.teacher_type === 'permanent'
      ? teacher.monthly_salary
      : hourlyRate === null
        ? null
        : Math.round(totals.hoursDone * hourlyRate);
  const amountAlreadyPaid =
    teacher.teacher_type === 'permanent'
      ? effectivePaidAmount
      : hourlyRate === null
        ? null
        : effectivePaidAmount;
  const amountRemainingToPayNow =
    teacher.teacher_type === 'permanent'
      ? Math.max(0, (teacher.monthly_salary ?? 0) - effectivePaidAmount)
      : hourlyRate === null
        ? null
        : Math.max(0, Math.round(remainingHoursToPay * hourlyRate));
  const remainingPotentialAmount =
    teacher.teacher_type === 'permanent'
      ? 0
      : hourlyRate === null
        ? null
        : Math.round(remainingPlannedHours * hourlyRate);
  const absenceAmount =
    teacher.teacher_type === 'permanent'
      ? 0
      : hourlyRate === null
        ? null
        : Math.round(absenceHours * hourlyRate);
  const isPartiallyPaid =
    teacher.teacher_type !== 'permanent' &&
    hourlyRate !== null &&
    hasMeaningfulValue(effectivePaidHours) &&
    effectivePaidHours + HOURS_PRECISION_EPSILON < totals.hoursDone;

  return {
    totals,
    totalFcfa,
    hoursDoneSinceLastPayment,
    absenceHours,
    remainingPlannedHours,
    currentEarnedAmount,
    amountAlreadyPaid,
    amountRemainingToPayNow,
    remainingPotentialAmount,
    absenceAmount,
    isPartiallyPaid,
  };
};
// Tolérance pour les comparaisons d'heures (évite les erreurs d'arrondi flottant)
// Exemple: 10.0000001 heures ≈ 10.0 heures (différence < HOURS_PRECISION_EPSILON)
// Utilisé pour comparer hours_done vs paid_hours et déterminer si un salaire est entièrement payé
const HOURS_PRECISION_EPSILON = 0.0001;

const hasMeaningfulValue = (value: number): boolean => value > HOURS_PRECISION_EPSILON;
const isZeroDueVacataire = (hoursDone: number, totalFcfa: number): boolean =>
  hoursDone <= HOURS_PRECISION_EPSILON || totalFcfa <= 0;
const resolveVacataireStatus = (input: {
  currentStatus: SalaryRecordStatus | null;
  hoursDone: number;
  totalFcfa: number;
  paidHours: number;
}): SalaryRecordStatus => {
  if (input.currentStatus === 'disputed') {
    return 'disputed';
  }

  if (isZeroDueVacataire(input.hoursDone, input.totalFcfa)) {
    return 'nothing_to_pay';
  }

  return input.paidHours + HOURS_PRECISION_EPSILON >= input.hoursDone ? 'paid' : 'pending';
};
export class BillingService {
  constructor(private readonly repository: BillingRepository) {}

  getMonthBounds(month: string): { monthStart: string; monthEnd: string } {
    return monthToBounds(month);
  }

  async getTeacherMonthlyAttendance(teacherId: string, month: string) {
    const { monthStart, monthEnd } = monthToBounds(month);

    const teacher = await this.repository.findTeacherById(teacherId);
    if (!teacher) {
      throw new BillingModuleError('Teacher not found', 404, 'TEACHER_NOT_FOUND');
    }

    // le détail jour par jour des heures planifiées et effectuées, avec les statuts de pointage (présent/absent/late/excused/not_marked) pour chaque cours du mois, utilisé pour afficher la timeline de pointage dans le détail du salaire du prof. 
    // Les heures planifiées et effectuées sont calculées à partir de l'emploi du temps (et non pas à partir des données d'assiduité) : si un cours de 2h est planifié mais que le prof a été absent, on affiche quand même 2h planifiées et 0h effectuées, avec un statut "absent" (et pas 0h planifiées et 0h effectuées) 
    // - c'est la règle qui prévaut pour le calcul du salaire : c'est parce qu'il avait 2h de cours planifiées qu'on considère qu'il doit être payé pour ces 2h, même s'il n'a pas fait le travail (sauf si le statut de pointage est "absent" ou "excused", auquel cas les heures ne sont pas payées).
    const daily = await this.repository.listTeacherDailyBreakdown(teacherId, monthStart, monthEnd);
    const rows = buildDailyRows(daily as DailyBreakdownRow[]);
    const totals = rows.reduce(
      (acc, row) => {
        acc.hoursPlanned += row.hoursPlanned;
        acc.hoursDone += row.hoursDone;
        return acc;
      },
      { hoursPlanned: 0, hoursDone: 0 }
    );

    return {
      month,
      summary: {
        hoursPlanned: roundHours(totals.hoursPlanned),
        hoursDone: roundHours(totals.hoursDone),
        totalFcfa: null,
        status: 'attendance_only',
      },
      rows,
    };
  }

  async getSalarySummary(month: string) {
    const { monthStart, monthEnd } = monthToBounds(month);
    const [allRows, lastComputedAt] = await Promise.all([
      this.repository.listTeacherMonthlyMetrics(monthStart, monthEnd),
      this.repository.getLastComputedDate(monthStart),
    ]);

    // Un enseignant n'apparaît dans le résumé du mois que s'il était réellement
    // en service : heures planifiées ou effectuées > 0. Sans activité, le mois
    // "n'existe pas" pour lui (même règle que computeSalaryRecords). On conserve
    // toutefois toute ligne déjà matérialisée (fiche existante ou paiement),
    // pour ne jamais masquer un salaire calculé ou versé.
    const rows = allRows.filter((row) => {
      const hoursPlanned = BillingRepository.toNumber(row.hours_planned);
      const hoursDone = BillingRepository.toNumber(row.hours_done);
      const hasActivity = hoursPlanned > 0 || hoursDone > 0;
      const hasMaterializedRecord = row.salary_record_id !== null || row.paid_at !== null;
      return hasActivity || hasMaterializedRecord;
    });

    const items = rows.map((row) => {
      const hoursPlanned = BillingRepository.toNumber(row.hours_planned);
      const hoursDone = BillingRepository.toNumber(row.hours_done);
      const totalFcfa = BillingRepository.toNumber(row.total_fcfa);
      // Pour un vacataire : montant effectivement versé = somme des salary_payments
      // C'est la valeur à afficher dans le total "Total payé" du dashboard
      const paidAmountForSummary = BillingRepository.toNumber(row.paid_amount);

      if (row.hourly_rate === null || row.teacher_type === 'permanent') {
        const effectivePaidAmount = hasMeaningfulValue(paidAmountForSummary)
          ? paidAmountForSummary
          : row.paid_at
            ? (row.monthly_salary ?? 0)
            : 0;
        // Pour un permanent legacy (paid_at défini mais salary_payments vide),
        // réconcilier le statut depuis paid_at plutôt que de lire salary_records.status
        // qui peut rester 'pending' sur les anciens enregistrements.
        const permanentStatus: SalaryRecordStatus =
          row.salary_status === 'disputed'
            ? 'disputed'
            : hasMeaningfulValue(effectivePaidAmount) && effectivePaidAmount + HOURS_PRECISION_EPSILON >= (row.monthly_salary ?? 0)
              ? 'paid'
              : row.salary_status ?? 'pending';
        return {
          teacherId: row.teacher_id,
          teacherName: row.teacher_name,
          teacherType: row.teacher_type,
          hoursPlanned: roundHours(hoursPlanned),
          hoursDone: roundHours(hoursDone),
          hourlyRate: null,
          totalFcfa: row.monthly_salary,
          amountAlreadyPaid: effectivePaidAmount,
          status: permanentStatus,
          salaryRecordId: row.salary_record_id,
          isPartiallyPaid: false,
          paidAt: row.paid_at,
        };
      }

      const paidHoursFromPayments = BillingRepository.toNumber(row.paid_hours);
      // Legacy vacataire : paid_at défini mais salary_payments vide → le paiement
      // a eu lieu avant l'introduction de la table salary_payments. On considère
      // que toutes les heures faites (total_fcfa de l'époque) ont été réglées.
      const isLegacyVacataire = !hasMeaningfulValue(paidHoursFromPayments) && row.paid_at !== null;
      const effectiveVacatairePaidAmount = hasMeaningfulValue(paidAmountForSummary)
        ? paidAmountForSummary
        : isLegacyVacataire
          ? totalFcfa
          : 0;
      const effectiveVacatairePaidHours = hasMeaningfulValue(paidHoursFromPayments)
        ? paidHoursFromPayments
        : isLegacyVacataire
          ? hoursDone
          : 0;
      const paidHoursForStatus = effectiveVacatairePaidHours;
      const isPartiallyPaid = hasMeaningfulValue(paidHoursForStatus) && paidHoursForStatus + HOURS_PRECISION_EPSILON < hoursDone;
      const baseStatus = row.salary_status ?? 'pending';
      const normalizedStatus = resolveVacataireStatus({
        currentStatus: baseStatus,
        hoursDone,
        totalFcfa,
        paidHours: paidHoursForStatus,
      });

      return {
        teacherId: row.teacher_id,
        teacherName: row.teacher_name,
        teacherType: row.teacher_type,
        hoursPlanned: roundHours(hoursPlanned),
        hoursDone: roundHours(hoursDone),
        hourlyRate: row.hourly_rate,
        totalFcfa,
        amountAlreadyPaid: effectiveVacatairePaidAmount,
        status: normalizedStatus,
        salaryRecordId: row.salary_record_id,
        isPartiallyPaid: normalizedStatus !== 'paid' ? isPartiallyPaid : false,
        paidAt: row.paid_at,
      };
    });

    items.sort((a, b) => (b.totalFcfa ?? -1) - (a.totalFcfa ?? -1));

    return {
      month,
      items,
      lastComputedAt,
    };
  }

  async getTeacherSalaryDetails(teacherId: string, month: string) {
    const { monthStart, monthEnd } = monthToBounds(month);

    const teacher = await this.repository.findTeacherById(teacherId);
    if (!teacher) {
      throw new BillingModuleError('Teacher not found', 404, 'TEACHER_NOT_FOUND');
    }

    const teacherMetrics = (
      await this.repository.listTeacherMonthlyMetrics(monthStart, monthEnd, teacherId)
    )[0];

    const daily = await this.repository.listTeacherDailyBreakdown(teacherId, monthStart, monthEnd);
    const rows = buildDailyRows(daily as DailyBreakdownRow[]);

    const salaryRecordId = teacherMetrics?.salary_record_id ?? null;
    const teacherMonthlyRecord = salaryRecordId
      ? await this.repository.getSalaryRecordById(salaryRecordId)
      : null;
    const paymentRows = salaryRecordId ? await this.repository.listPaymentsForRecord(salaryRecordId) : [];
    const paidSummary = salaryRecordId
      ? await this.repository.getSalaryPaymentsSummary(salaryRecordId)
      : { paid_hours: 0, paid_amount: 0, payments_count: 0, last_paid_at: null };
    const paidHoursFromPayments = BillingRepository.toNumber(paidSummary.paid_hours);
    const paidAmountFromPayments = BillingRepository.toNumber(paidSummary.paid_amount);
    const isLegacyVacataire =
      teacher.teacher_type === 'vacataire' &&
      !hasMeaningfulValue(paidHoursFromPayments) &&
      (teacherMetrics?.paid_at ?? null) !== null;
    const effectivePaidHours =
      teacher.teacher_type === 'vacataire'
        ? hasMeaningfulValue(paidHoursFromPayments)
          ? paidHoursFromPayments
          : isLegacyVacataire
            ? BillingRepository.toNumber(teacherMetrics?.hours_done ?? 0)
            : 0
        : 0;
    const effectivePaidAmount =
      teacher.teacher_type === 'permanent'
        ? hasMeaningfulValue(paidAmountFromPayments)
          ? paidAmountFromPayments
          : teacherMetrics?.paid_at
            ? teacher.monthly_salary ?? 0
            : 0
        : hasMeaningfulValue(paidAmountFromPayments)
          ? paidAmountFromPayments
          : isLegacyVacataire
            ? BillingRepository.toNumber(teacherMetrics?.total_fcfa ?? 0)
            : 0;

    const financials = computeTeacherFinancials(rows, teacher, teacherMetrics, effectivePaidHours, effectivePaidAmount);

    const baseStatus = teacherMetrics?.salary_status ?? 'pending';
    const normalizedStatus: SalaryRecordStatus =
      teacher.teacher_type === 'vacataire' && financials.totalFcfa !== null
        ? resolveVacataireStatus({
            currentStatus: baseStatus,
            hoursDone: financials.totals.hoursDone,
            totalFcfa: financials.totalFcfa,
            paidHours: effectivePaidHours,
          })
        : baseStatus === 'disputed'
          ? 'disputed'
          : hasMeaningfulValue(effectivePaidAmount) && effectivePaidAmount + HOURS_PRECISION_EPSILON >= (teacher.monthly_salary ?? 0)
            ? 'paid'
            : baseStatus;

    const normalizedPaymentRows =
      paymentRows.length > 0
        ? paymentRows
        : teacherMetrics?.paid_at
          ? [
              {
                id: `legacy-${salaryRecordId ?? teacherId}`,
                salary_record_id: salaryRecordId ?? '',
                hours_paid: teacher.teacher_type === 'vacataire' ? effectivePaidHours : null,
                amount_fcfa: effectivePaidAmount,
                paid_at: teacherMetrics.paid_at,
                paid_by: teacherMetrics.paid_by ?? '',
                paid_by_name: teacherMetrics.paid_by_name,
                paid_by_role: null,
                notes: teacherMonthlyRecord?.notes ?? teacherMetrics.notes ?? null,
              },
            ]
          : [];
    const lastPayment = normalizedPaymentRows[0] ?? null;

    return {
      month,
      teacher: {
        id: teacher.teacher_id,
        name: teacher.teacher_name,
        type: teacher.teacher_type,
        hourlyRate: teacher.hourly_rate,
        monthlySalary: teacher.monthly_salary,
      },
      summary: {
        hoursPlanned: roundHours(financials.totals.hoursPlanned),
        hoursDone: roundHours(financials.totals.hoursDone),
        totalFcfa: financials.totalFcfa,
        status: normalizedStatus,
        absenceHours: financials.absenceHours,
        remainingPlannedHours: financials.remainingPlannedHours,
        currentEarnedAmount: financials.currentEarnedAmount,
        amountAlreadyPaid: financials.amountAlreadyPaid,
        amountRemainingToPayNow: financials.amountRemainingToPayNow,
        remainingPotentialAmount: financials.remainingPotentialAmount,
        absenceAmount: financials.absenceAmount,
        hoursDoneSinceLastPayment: financials.hoursDoneSinceLastPayment,
        isPartiallyPaid: normalizedStatus !== 'paid' ? financials.isPartiallyPaid : false,
      },
      payment: {
        paidAt: lastPayment?.paid_at ?? teacherMetrics?.paid_at ?? null,
        paidBy: lastPayment?.paid_by ?? teacherMetrics?.paid_by ?? null,
        paidByName: lastPayment?.paid_by_name ?? teacherMetrics?.paid_by_name ?? null,
        paidByRole: lastPayment?.paid_by_role ?? null,
        notes: lastPayment?.notes ?? teacherMonthlyRecord?.notes ?? teacherMetrics?.notes ?? null,
      },
      payments: normalizedPaymentRows.map((paymentRow) => ({
        id: paymentRow.id,
        hoursPaid: paymentRow.hours_paid === null ? null : roundHours(BillingRepository.toNumber(paymentRow.hours_paid)),
        amountFcfa: paymentRow.amount_fcfa,
        paidAt: paymentRow.paid_at,
        paidBy: paymentRow.paid_by,
        paidByName: paymentRow.paid_by_name,
        paidByRole: paymentRow.paid_by_role,
        notes: paymentRow.notes,
      })),
      rows,
    };
  }

  async computeSalaryRecords(month: string) {
    const { monthStart, monthEnd } = monthToBounds(month);
    const rows = await this.repository.listTeacherMonthlyMetrics(monthStart, monthEnd);
    const canStoreNothingToPay = await this.repository.hasSalaryStatusValue('nothing_to_pay');

    const recordsToUpsert: Array<{
      teacherId: string;
      periodMonth: string;
      hoursPlanned: number;
      hoursDone: number;
      hourlyRate: number;
      totalFcfa: number;
      status: SalaryRecordStatus;
      notes: string | null;
    }> = [];

    for (const row of rows) {
      const hoursPlanned = roundHours(BillingRepository.toNumber(row.hours_planned));
      const hoursDone = roundHours(BillingRepository.toNumber(row.hours_done));

      // skip vacataire sans taux horaire
      if (row.teacher_type !== 'permanent' && row.hourly_rate === null) {
        continue;
      }

      // Skip vacataire avec 0 heure faite ET 0 heure prévue = ce mois n'existe pas pour lui
      if (row.teacher_type !== 'permanent' && hoursPlanned <= 0 && hoursDone <= 0) {
        continue;
      }

      // Skip permanent sans aucune heure planifiée = il n'était pas en service ce mois-là.
      // Le forfait mensuel n'est dû que si le prof avait un emploi du temps actif.
      // Évite des fiches "fantômes" non soldées sur des mois sans activité.
      if (row.teacher_type === 'permanent' && hoursPlanned <= 0) {
        continue;
      }

      const totalFcfa =
        row.teacher_type === 'permanent'
          ? row.monthly_salary ?? 0
          : Math.round(hoursDone * (row.hourly_rate ?? 0));
      const currentStatus = row.salary_status;
      const paidHoursFromPayments = BillingRepository.toNumber(row.paid_hours);
      const paidHours = paidHoursFromPayments;
      const paidAmountFromPayments = BillingRepository.toNumber(row.paid_amount);
      const paidAmount =
        hasMeaningfulValue(paidAmountFromPayments) || !row.paid_at ? paidAmountFromPayments : totalFcfa;

      const nextStatus: SalaryRecordStatus =
        currentStatus === 'disputed'
          ? 'disputed'
          : row.teacher_type === 'vacataire' && hoursDone <= HOURS_PRECISION_EPSILON
            ? 'nothing_to_pay'
            : row.teacher_type === 'permanent'
              ? (paidAmount + HOURS_PRECISION_EPSILON >= totalFcfa ? 'paid' : 'pending')
              : (paidHours + HOURS_PRECISION_EPSILON >= hoursDone ? 'paid' : 'pending');
      const storedStatus =
        nextStatus === 'nothing_to_pay' && !canStoreNothingToPay ? 'pending' : nextStatus;

      recordsToUpsert.push({
        teacherId: row.teacher_id,
        periodMonth: monthStart,
        hoursPlanned,
        hoursDone,
        hourlyRate: row.hourly_rate ?? 0,
        totalFcfa,
        status: storedStatus,
        notes: row.notes,
      });
    }

    const updatedCount = await this.repository.batchUpsertSalaryRecords(recordsToUpsert);

    return {
      month,
      updatedCount,
    };
  }

  async getPastUnpaidSalaryAlerts(referenceMonth: string) {
    const { monthStart } = monthToBounds(referenceMonth);
    const rows = await this.repository.listPastUnpaidSalaryAlerts(monthStart);
    const months = rows.map((row) => ({
      month: row.period_month.slice(0, 7),
      recordsCount: BillingRepository.toNumber(row.records_count),
      totalRemainingFcfa: BillingRepository.toNumber(row.total_remaining_fcfa),
    }));

    return {
      referenceMonth,
      count: months.reduce((sum, row) => sum + row.recordsCount, 0),
      totalRemainingFcfa: months.reduce((sum, row) => sum + row.totalRemainingFcfa, 0),
      months,
    };
  }

  async updateSalaryRecordStatus(input: {
    recordId: string;
    status: 'paid' | 'disputed';
    notes?: string;
    hoursToPay?: number;
    actor: { userId: string; role: 'director' | 'staff' | 'teacher' | 'super_admin'; schemaName: string; tenantId?: string };
    /** True quand la mutation provient d'une synchronisation offline (PWA). */
    fromOfflineSync?: boolean;
  }) {
    // Le droit de marquer un salaire « payé » est porté par la permission
    // salary.mark_paid (guard du controller), seule autorité. Pas de restriction
    // de rôle supplémentaire ici : tout détenteur de la permission peut décaisser.
    const existing = await this.repository.getSalaryRecordById(input.recordId);
    if (!existing) {
      throw new BillingModuleError('Salary record not found', 404, 'SALARY_RECORD_NOT_FOUND');
    }
    let updated;
    // Garde trace du paiement effectivement créé pour émettre l'event de recalcul
    // (null pour 'disputed', qui ne crée pas de paiement).
    let recordedPayment: { amountFcfa: number; hoursPaid: number | null } | null = null;
    if (input.status === 'disputed') {
      updated = await this.repository.updateSalaryStatus({
        recordId: input.recordId,
        status: input.status,
        notes: input.notes,
      });
    } else {
      const paidSummary = await this.repository.getSalaryPaymentsSummary(input.recordId);
      const paidAmountFromPayments = BillingRepository.toNumber(paidSummary.paid_amount);
      // pour utilise la variable existing.teacher_type pour detecter les vacataires
      const isVacataire = existing.teacher_type === 'vacataire';

      if (!isVacataire) {
        const paidAmount =
          hasMeaningfulValue(paidAmountFromPayments) || !existing.paid_at
            ? paidAmountFromPayments
            : existing.total_fcfa;
        if (paidAmount + HOURS_PRECISION_EPSILON >= existing.total_fcfa) {
          throw new BillingModuleError(
            'Salary already paid for this month',
            409,
            'SALARY_ALREADY_PAID_FOR_MONTH'
          );
        }

        await this.repository.createSalaryPayment({
          recordId: input.recordId,
          hoursPaid: null,
          amountFcfa: existing.total_fcfa,
          paidBy: input.actor.userId,
          notes: input.notes,
        });
        updated = await this.repository.updateSalaryRecordAfterPayment({
          recordId: input.recordId,
          status: 'paid',
          notes: input.notes,
          paidBy: input.actor.userId,
        });
        recordedPayment = { amountFcfa: existing.total_fcfa, hoursPaid: null };
      } else {
        // Validation préliminaire (avant transaction)
        if (input.hoursToPay === undefined || !Number.isFinite(input.hoursToPay) || input.hoursToPay <= 0) {
          throw new BillingModuleError(
            'hoursToPay is required for vacataire payment',
            400,
            'HOURS_TO_PAY_REQUIRED'
          );
        }

        const requestedHours = roundHours(input.hoursToPay);

        // Utiliser la méthode atomique avec SELECT FOR UPDATE pour éviter les race conditions
        try {
          const result = await this.repository.createVacatairePartialPaymentAtomic({
            recordId: input.recordId,
            requestedHours,
            hourlyRate: existing.hourly_rate,
            paidBy: input.actor.userId,
            notes: input.notes,
          });

          updated = result.record;
          recordedPayment = {
            amountFcfa: result.payment.amount_fcfa,
            hoursPaid:
              result.payment.hours_paid === null
                ? null
                : BillingRepository.toNumber(result.payment.hours_paid),
          };
        } catch (error) {
          // La transaction a échoué : soit heures insuffisantes, soit record non trouvé
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';

          if (errorMessage.includes('insufficient remaining hours')) {
            throw new BillingModuleError(
              'hoursToPay exceeds remaining unpaid hours',
              400,
              'HOURS_TO_PAY_EXCEEDS_REMAINING'
            );
          }

          if (errorMessage.includes('record not found')) {
            throw new BillingModuleError(
              'Salary record not found',
              404,
              'SALARY_RECORD_NOT_FOUND'
            );
          }

          // Autre erreur inattendue
          throw error;
        }
      }
    }

    if (!updated) {
      throw new BillingModuleError('Salary record not found', 404, 'SALARY_RECORD_NOT_FOUND');
    }

    await this.repository.auditSalaryAction({
      schemaName: input.actor.schemaName,
      actorId: input.actor.userId,
      actorRole: input.actor.role,
      action: input.status === 'paid' ? 'salary.mark_paid' : 'salary.mark_disputed',
      before: existing,
      after: {
        recordId: updated.id,
        teacherId: updated.teacher_id,
        periodMonth: updated.period_month,
        status: updated.status,
        totalFcfa: updated.total_fcfa,
        paidAt: updated.paid_at,
        paidBy: updated.paid_by,
        notes: updated.notes,
        hoursToPay: input.hoursToPay ?? null,
      },
    });

    if (recordedPayment) {
      // Déclenche un recalcul async du salary_record en lisant l'état courant
      // des pointages (validations, sanctions, annulations) - voir
      // registerSalaryEventListeners dans salaries.service.ts.
      emit('salary.payment_recorded', {
        tenantId: input.actor.tenantId ?? '',
        schemaName: input.actor.schemaName,
        teacherId: updated.teacher_id,
        salaryRecordId: updated.id,
        periodMonth: updated.period_month.slice(0, 7),
        amountFcfa: recordedPayment.amountFcfa,
        hoursPaid: recordedPayment.hoursPaid,
        paidBy: input.actor.userId,
        fromOfflineSync: input.fromOfflineSync ?? false,
      });
    }

    return {
      record: {
        id: updated.id,
        teacherId: updated.teacher_id,
        periodMonth: updated.period_month.slice(0, 7),
        hoursPlanned: roundHours(BillingRepository.toNumber(updated.hours_planned)),
        hoursDone: roundHours(BillingRepository.toNumber(updated.hours_done)),
        hourlyRate: updated.hourly_rate,
        totalFcfa: updated.total_fcfa,
        status: updated.status,
        paidAt: updated.paid_at,
        paidBy: updated.paid_by,
        notes: updated.notes,
      },
    };
  }

  async getExportTeacherPayload(teacherId: string, month: string) {
    return this.getTeacherSalaryDetails(teacherId, month);
  }

  async getExportSchoolPayload(month: string) {
    return this.getSalarySummary(month);
  }

  async getTeacherPaymentHistory(teacherId: string, limit: number, offset = 0) {
    const teacher = await this.repository.findTeacherById(teacherId);
    if (!teacher) {
      throw new BillingModuleError('Teacher not found', 404, 'TEACHER_NOT_FOUND');
    }

    const rows = await this.repository.listTeacherPaymentHistory(teacherId, limit, offset);
    return {
      teacher: {
        id: teacher.teacher_id,
        name: teacher.teacher_name,
        type: teacher.teacher_type,
      },
      items: rows.map((row) => ({
        paymentId: row.payment_id,
        recordId: row.record_id,
        month: row.period_month.slice(0, 7),
        hoursPaid: row.hours_paid === null ? null : roundHours(BillingRepository.toNumber(row.hours_paid)),
        amountFcfa: row.amount_fcfa,
        status: row.status,
        paidAt: row.paid_at,
        paidBy: row.paid_by,
        paidByName: row.paid_by_name,
        paidByRole: row.paid_by_role,
        notes: row.notes,
      })),
    };
  }
}

export const buildBillingService = (db: ConstructorParameters<typeof BillingRepository>[0]) =>
  new BillingService(new BillingRepository(db));
