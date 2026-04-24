import { BillingRepository, type SalaryRecordStatus } from './billing.repository.js';

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

  const monthStart = `${yearRaw}-${monthRaw}-01`;
  const endDate = new Date(Date.UTC(year, monthNumber, 0));
  const monthEnd = endDate.toISOString().slice(0, 10);
  return { monthStart, monthEnd };
};

const roundHours = (value: number): number => Math.round(value * 100) / 100;
const EPSILON = 0.0001;
const hasMeaningfulValue = (value: number): boolean => value > EPSILON;
const isZeroDueVacataire = (hoursDone: number, totalFcfa: number): boolean =>
  hoursDone <= EPSILON || totalFcfa <= 0;
const resolveEffectivePaidHoursFromMetrics = (input: {
  hoursDone: number;
  paidAt: string | null;
  hoursDoneSincePaid: number;
  paidHoursTotal: number;
  paidHoursBeforeCutoff: number;
  paidHoursAfterCutoff: number;
}): { effectivePaidHours: number; legacyPaidHours: number } => {
  if (!input.paidAt) {
    return {
      effectivePaidHours: Math.max(0, roundHours(input.paidHoursTotal)),
      legacyPaidHours: 0,
    };
  }

  const baselinePaidAtCutoff = Math.max(0, roundHours(input.hoursDone - input.hoursDoneSincePaid));
  const legacyPaidHours = Math.max(0, roundHours(baselinePaidAtCutoff - input.paidHoursBeforeCutoff));
  const effectivePaidHours = Math.max(0, roundHours(baselinePaidAtCutoff + input.paidHoursAfterCutoff));

  return {
    effectivePaidHours,
    legacyPaidHours,
  };
};

export class BillingService {
  constructor(private readonly repository: BillingRepository) {}

  getMonthBounds(month: string): { monthStart: string; monthEnd: string } {
    return monthToBounds(month);
  }

  async getSalarySummary(month: string) {
    const { monthStart, monthEnd } = monthToBounds(month);
    const rows = await this.repository.listTeacherMonthlyMetrics(monthStart, monthEnd);

    const items = rows.map((row) => {
      const hoursPlanned = BillingRepository.toNumber(row.hours_planned);
      const hoursDone = BillingRepository.toNumber(row.hours_done);
      const totalFcfa = BillingRepository.toNumber(row.total_fcfa);

      if (row.hourly_rate === null || row.teacher_type === 'permanent') {
        return {
          teacherId: row.teacher_id,
          teacherName: row.teacher_name,
          teacherType: row.teacher_type,
          hoursPlanned: roundHours(hoursPlanned),
          hoursDone: roundHours(hoursDone),
          hourlyRate: null,
          totalFcfa: row.monthly_salary,
          status: row.salary_status ?? 'pending',
          salaryRecordId: row.salary_record_id,
          isPartiallyPaid: false,
          paidAt: row.paid_at,
        };
      }

      const paidHoursFromPayments = BillingRepository.toNumber(row.paid_hours);
      const paidHoursBeforeCutoff = BillingRepository.toNumber(row.paid_hours_before_paid_at);
      const paidHoursAfterCutoff = BillingRepository.toNumber(row.paid_hours_after_paid_at);
      const hoursDoneSincePaid = BillingRepository.toNumber(row.hours_done_since_paid);
      const { effectivePaidHours } = resolveEffectivePaidHoursFromMetrics({
        hoursDone,
        paidAt: row.paid_at,
        hoursDoneSincePaid,
        paidHoursTotal: paidHoursFromPayments,
        paidHoursBeforeCutoff,
        paidHoursAfterCutoff,
      });
      const isPartiallyPaid = hasMeaningfulValue(effectivePaidHours) && effectivePaidHours + EPSILON < hoursDone;
      const baseStatus = row.salary_status ?? 'pending';
      const normalizedStatus: SalaryRecordStatus =
        baseStatus === 'disputed'
          ? 'disputed'
          : isZeroDueVacataire(hoursDone, totalFcfa)
            ? 'paid'
            : baseStatus;

      return {
        teacherId: row.teacher_id,
        teacherName: row.teacher_name,
        teacherType: row.teacher_type,
        hoursPlanned: roundHours(hoursPlanned),
        hoursDone: roundHours(hoursDone),
        hourlyRate: row.hourly_rate,
        totalFcfa,
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
    };
  }

  async getTeacherSalaryDetails(teacherId: string, month: string) {
    const { monthStart, monthEnd } = monthToBounds(month);

    const teacher = await this.repository.findTeacherById(teacherId);
    if (!teacher) {
      throw new BillingModuleError('Teacher not found', 404, 'TEACHER_NOT_FOUND');
    }

    const teacherMetrics = (
      await this.repository.listTeacherMonthlyMetrics(monthStart, monthEnd)
    ).find((row) => row.teacher_id === teacherId);

    const daily = await this.repository.listTeacherDailyBreakdown(teacherId, monthStart, monthEnd);
    const now = new Date();
    const todayIso = now.toISOString().slice(0, 10);
    const currentTime = now.toISOString().slice(11, 16);

    const rows = daily.map((row) => {
      const hoursPlanned = BillingRepository.toNumber(row.hours_planned);
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
        hoursDone: roundHours(countedAsDone ? hoursPlanned : 0),
      };
    });

    const totals = rows.reduce(
      (acc, row) => {
        acc.hoursPlanned += row.hoursPlanned;
        acc.hoursDone += row.hoursDone;
        if (row.attendanceStatus === 'absent') {
          acc.absenceHours += row.hoursPlanned;
        }
        return acc;
      },
      { hoursPlanned: 0, hoursDone: 0, absenceHours: 0 }
    );

    const hourlyRate = teacher.hourly_rate;
    const totalFcfa =
      teacher.teacher_type === 'permanent'
        ? teacher.monthly_salary
        : hourlyRate === null
          ? null
          : Math.round(totals.hoursDone * hourlyRate);
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
    const hoursDoneSincePaid = teacherMetrics ? BillingRepository.toNumber(teacherMetrics.hours_done_since_paid) : 0;
    const paidHoursBeforeCutoff = teacherMetrics
      ? BillingRepository.toNumber(teacherMetrics.paid_hours_before_paid_at)
      : 0;
    const paidHoursAfterCutoff = teacherMetrics
      ? BillingRepository.toNumber(teacherMetrics.paid_hours_after_paid_at)
      : 0;
    const { effectivePaidHours: computedEffectivePaidHours } =
      teacher.teacher_type === 'vacataire'
        ? resolveEffectivePaidHoursFromMetrics({
            hoursDone: totals.hoursDone,
            paidAt: teacherMetrics?.paid_at ?? null,
            hoursDoneSincePaid,
            paidHoursTotal: paidHoursFromPayments,
            paidHoursBeforeCutoff,
            paidHoursAfterCutoff,
          })
        : { effectivePaidHours: 0 };
    const effectivePaidHours =
      teacher.teacher_type === 'vacataire' ? computedEffectivePaidHours : 0;
    const effectivePaidAmount =
      teacher.teacher_type === 'permanent'
        ? hasMeaningfulValue(paidAmountFromPayments)
          ? paidAmountFromPayments
          : teacherMetrics?.paid_at
            ? teacher.monthly_salary ?? 0
            : 0
        : hourlyRate === null
          ? 0
          : Math.max(paidAmountFromPayments, Math.round(effectivePaidHours * hourlyRate));
    const remainingHoursToPay = Math.max(
      0,
      totals.hoursDone - (teacher.teacher_type === 'vacataire' ? effectivePaidHours : 0)
    );
    const hoursDoneSinceLastPayment =
      teacher.teacher_type === 'vacataire' && teacherMetrics?.paid_at
        ? roundHours(Math.max(0, hoursDoneSincePaid))
        : 0;
    const absenceHours = roundHours(totals.absenceHours);
    const remainingPlannedHours = roundHours(
      Math.max(0, totals.hoursPlanned - totals.hoursDone - totals.absenceHours)
    );
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
      effectivePaidHours + EPSILON < totals.hoursDone;
    const baseStatus = teacherMetrics?.salary_status ?? 'pending';
    const normalizedStatus: SalaryRecordStatus =
      baseStatus === 'disputed'
        ? 'disputed'
        : teacher.teacher_type === 'vacataire' && totalFcfa !== null && isZeroDueVacataire(totals.hoursDone, totalFcfa)
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
        hourlyRate,
        monthlySalary: teacher.monthly_salary,
      },
      summary: {
        hoursPlanned: roundHours(totals.hoursPlanned),
        hoursDone: roundHours(totals.hoursDone),
        totalFcfa,
        status: normalizedStatus,
        absenceHours,
        remainingPlannedHours,
        currentEarnedAmount,
        amountAlreadyPaid,
        amountRemainingToPayNow,
        remainingPotentialAmount,
        absenceAmount,
        hoursDoneSinceLastPayment,
        isPartiallyPaid: normalizedStatus !== 'paid' ? isPartiallyPaid : false,
      },
      payment: {
        paidAt: lastPayment?.paid_at ?? teacherMetrics?.paid_at ?? null,
        paidBy: lastPayment?.paid_by ?? teacherMetrics?.paid_by ?? null,
        paidByName: lastPayment?.paid_by_name ?? teacherMetrics?.paid_by_name ?? null,
        notes: lastPayment?.notes ?? teacherMonthlyRecord?.notes ?? teacherMetrics?.notes ?? null,
      },
      payments: normalizedPaymentRows.map((paymentRow) => ({
        id: paymentRow.id,
        hoursPaid: paymentRow.hours_paid === null ? null : roundHours(BillingRepository.toNumber(paymentRow.hours_paid)),
        amountFcfa: paymentRow.amount_fcfa,
        paidAt: paymentRow.paid_at,
        paidBy: paymentRow.paid_by,
        paidByName: paymentRow.paid_by_name,
        notes: paymentRow.notes,
      })),
      rows,
    };
  }

  async computeSalaryRecords(month: string) {
    const { monthStart, monthEnd } = monthToBounds(month);

    const rows = await this.repository.listTeacherMonthlyMetrics(monthStart, monthEnd);

    let updatedCount = 0;
    for (const row of rows) {
      if (row.teacher_type !== 'permanent' && row.hourly_rate === null) {
        continue;
      }

      const hoursPlanned = roundHours(BillingRepository.toNumber(row.hours_planned));
      const hoursDone = roundHours(BillingRepository.toNumber(row.hours_done));
      const totalFcfa =
        row.teacher_type === 'permanent'
          ? row.monthly_salary ?? 0
          : Math.round(hoursDone * (row.hourly_rate ?? 0));
      const currentStatus = row.salary_status;
      const paidHoursFromPayments = BillingRepository.toNumber(row.paid_hours);
      const { effectivePaidHours } = resolveEffectivePaidHoursFromMetrics({
        hoursDone,
        paidAt: row.paid_at,
        hoursDoneSincePaid: BillingRepository.toNumber(row.hours_done_since_paid),
        paidHoursTotal: paidHoursFromPayments,
        paidHoursBeforeCutoff: BillingRepository.toNumber(row.paid_hours_before_paid_at),
        paidHoursAfterCutoff: BillingRepository.toNumber(row.paid_hours_after_paid_at),
      });
      const paidHours = effectivePaidHours;
      const paidAmountFromPayments = BillingRepository.toNumber(row.paid_amount);
      const paidAmount =
        hasMeaningfulValue(paidAmountFromPayments) || !row.paid_at ? paidAmountFromPayments : totalFcfa;

      const nextStatus: SalaryRecordStatus =
        currentStatus === 'disputed'
          ? 'disputed'
          : row.teacher_type === 'permanent'
            ? (paidAmount + EPSILON >= totalFcfa ? 'paid' : 'pending')
            : (paidHours + EPSILON >= hoursDone ? 'paid' : 'pending');

      await this.repository.upsertSalaryRecord({
        teacherId: row.teacher_id,
        periodMonth: monthStart,
        hoursPlanned,
        hoursDone,
        hourlyRate: row.hourly_rate ?? 0,
        totalFcfa,
        status: nextStatus,
        notes: row.notes,
      });

      updatedCount += 1;
    }

    return {
      month,
      updatedCount,
    };
  }

  async updateSalaryRecordStatus(input: {
    recordId: string;
    status: 'paid' | 'disputed';
    notes?: string;
    hoursToPay?: number;
    actor: { userId: string; role: 'director' | 'staff' | 'teacher' | 'super_admin' };
  }) {
    if (input.status === 'paid' && input.actor.role !== 'director') {
      throw new BillingModuleError(
        'Only director can mark salary as paid',
        403,
        'DIRECTOR_REQUIRED_FOR_PAID'
      );
    }

    const existing = await this.repository.getSalaryRecordById(input.recordId);
    if (!existing) {
      throw new BillingModuleError('Salary record not found', 404, 'SALARY_RECORD_NOT_FOUND');
    }
    let updated;
    if (input.status === 'disputed') {
      updated = await this.repository.updateSalaryStatus({
        recordId: input.recordId,
        status: input.status,
        notes: input.notes,
      });
    } else {
      const paidSummary = await this.repository.getSalaryPaymentsSummary(input.recordId);
      const paidAmountFromPayments = BillingRepository.toNumber(paidSummary.paid_amount);
      const isVacataire = existing.hourly_rate > 0;

      if (!isVacataire) {
        const paidAmount =
          hasMeaningfulValue(paidAmountFromPayments) || !existing.paid_at
            ? paidAmountFromPayments
            : existing.total_fcfa;
        if (paidAmount + EPSILON >= existing.total_fcfa) {
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
      } else {
        const paidHoursFromPayments = BillingRepository.toNumber(paidSummary.paid_hours);
        const doneHours = BillingRepository.toNumber(existing.hours_done);
        const periodMonth = existing.period_month.slice(0, 7);
        const { monthStart, monthEnd } = monthToBounds(periodMonth);
        const monthMetrics = (
          await this.repository.listTeacherMonthlyMetrics(monthStart, monthEnd)
        ).find((row) => row.teacher_id === existing.teacher_id);
        const { effectivePaidHours } = resolveEffectivePaidHoursFromMetrics({
          hoursDone: doneHours,
          paidAt: existing.paid_at,
          hoursDoneSincePaid: monthMetrics ? BillingRepository.toNumber(monthMetrics.hours_done_since_paid) : 0,
          paidHoursTotal: paidHoursFromPayments,
          paidHoursBeforeCutoff: monthMetrics ? BillingRepository.toNumber(monthMetrics.paid_hours_before_paid_at) : 0,
          paidHoursAfterCutoff: monthMetrics ? BillingRepository.toNumber(monthMetrics.paid_hours_after_paid_at) : 0,
        });
        const paidHours = effectivePaidHours;
        const remainingHours = Math.max(0, doneHours - paidHours);

        if (remainingHours <= EPSILON) {
          throw new BillingModuleError(
            'Salary already paid for this month',
            409,
            'SALARY_ALREADY_PAID_FOR_MONTH'
          );
        }

        if (input.hoursToPay === undefined || !Number.isFinite(input.hoursToPay) || input.hoursToPay <= 0) {
          throw new BillingModuleError(
            'hoursToPay is required for vacataire payment',
            400,
            'HOURS_TO_PAY_REQUIRED'
          );
        }

        const requestedHours = roundHours(input.hoursToPay);
        if (requestedHours - remainingHours > EPSILON) {
          throw new BillingModuleError(
            'hoursToPay exceeds remaining unpaid hours',
            400,
            'HOURS_TO_PAY_EXCEEDS_REMAINING'
          );
        }

        const amountFcfa = Math.round(requestedHours * existing.hourly_rate);
        await this.repository.createSalaryPayment({
          recordId: input.recordId,
          hoursPaid: requestedHours,
          amountFcfa,
          paidBy: input.actor.userId,
          notes: input.notes,
        });

        const newPaidHours = paidHours + requestedHours;
        const nextStatus: SalaryRecordStatus = newPaidHours + EPSILON >= doneHours ? 'paid' : 'pending';
        updated = await this.repository.updateSalaryRecordAfterPayment({
          recordId: input.recordId,
          status: nextStatus,
          notes: input.notes,
          paidBy: input.actor.userId,
          touchPaidAt: nextStatus === 'paid',
        });
      }
    }

    if (!updated) {
      throw new BillingModuleError('Salary record not found', 404, 'SALARY_RECORD_NOT_FOUND');
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

  async getTeacherPaymentHistory(teacherId: string, limit: number) {
    const teacher = await this.repository.findTeacherById(teacherId);
    if (!teacher) {
      throw new BillingModuleError('Teacher not found', 404, 'TEACHER_NOT_FOUND');
    }

    const rows = await this.repository.listTeacherPaymentHistory(teacherId, limit);
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
        notes: row.notes,
      })),
    };
  }
}

export const buildBillingService = (db: ConstructorParameters<typeof BillingRepository>[0]) =>
  new BillingService(new BillingRepository(db));
