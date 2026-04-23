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
const toIsoDateTime = (date: string, time: string): Date | null => {
  const normalizedTime = time.slice(0, 5);
  const value = new Date(`${date}T${normalizedTime}:00Z`);
  return Number.isNaN(value.getTime()) ? null : value;
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
          status: 'Salaire fixe',
          salaryRecordId: row.salary_record_id,
          isPartiallyPaid: false,
          paidAt: row.paid_at,
        };
      }

      const hoursDoneSincePaid = BillingRepository.toNumber(row.hours_done_since_paid);
      const isPartiallyPaid = row.salary_status === 'paid' && roundHours(hoursDoneSincePaid) > 0;

      return {
        teacherId: row.teacher_id,
        teacherName: row.teacher_name,
        teacherType: row.teacher_type,
        hoursPlanned: roundHours(hoursPlanned),
        hoursDone: roundHours(hoursDone),
        hourlyRate: row.hourly_rate,
        totalFcfa,
        status: row.salary_status ?? 'pending',
        salaryRecordId: row.salary_record_id,
        isPartiallyPaid,
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
    const teacherMonthlyRecord = teacherMetrics?.salary_record_id
      ? await this.repository.getSalaryRecordById(teacherMetrics.salary_record_id)
      : null;
    const paidAt = teacherMetrics?.paid_at ?? null;
    const paidAtDate = paidAt ? new Date(paidAt) : null;
    const isPaidAtValid = paidAtDate !== null && !Number.isNaN(paidAtDate.getTime());
    const paidHours = isPaidAtValid
      ? rows.reduce((acc, row) => {
          const rowEndDate = toIsoDateTime(row.date, row.endTime);
          const countedAsDone =
            row.attendanceStatus === 'present' ||
            row.attendanceStatus === 'late' ||
            row.attendanceStatus === 'excused';
          if (!countedAsDone || rowEndDate === null || paidAtDate === null || rowEndDate > paidAtDate) {
            return acc;
          }
          return acc + row.hoursPlanned;
        }, 0)
      : 0;
    const earnedHoursAfterLastPayment = Math.max(0, totals.hoursDone - paidHours);
    const absenceHours = roundHours(totals.absenceHours);
    const remainingPlannedHours = roundHours(
      Math.max(0, totals.hoursPlanned - totals.hoursDone - totals.absenceHours)
    );
    const currentEarnedAmount = hourlyRate === null ? null : Math.round(totals.hoursDone * hourlyRate);
    const amountAlreadyPaid =
      hourlyRate === null
        ? null
        : teacherMetrics?.salary_status === 'paid'
          ? Math.max(0, Math.round(totals.hoursDone * hourlyRate) - Math.round(earnedHoursAfterLastPayment * hourlyRate))
          : 0;
    const amountRemainingToPayNow =
      hourlyRate === null
        ? null
        : teacherMetrics?.salary_status === 'paid'
          ? Math.round(earnedHoursAfterLastPayment * hourlyRate)
          : Math.round(totals.hoursDone * hourlyRate);
    const remainingPotentialAmount =
      hourlyRate === null ? null : Math.round(remainingPlannedHours * hourlyRate);
    const absenceAmount = hourlyRate === null ? null : Math.round(absenceHours * hourlyRate);
    const isPartiallyPaid =
      teacher.teacher_type !== 'permanent' &&
      hourlyRate !== null &&
      (teacherMetrics?.salary_status ?? 'pending') === 'paid' &&
      roundHours(earnedHoursAfterLastPayment) > 0;

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
        status:
          teacher.teacher_type === 'permanent' || hourlyRate === null
            ? 'Salaire fixe'
            : (teacherMetrics?.salary_status ?? 'pending'),
        absenceHours,
        remainingPlannedHours,
        currentEarnedAmount,
        amountAlreadyPaid,
        amountRemainingToPayNow,
        remainingPotentialAmount,
        absenceAmount,
        isPartiallyPaid,
      },
      payment: {
        paidAt: teacherMetrics?.paid_at ?? null,
        paidBy: teacherMetrics?.paid_by ?? null,
        paidByName: teacherMetrics?.paid_by_name ?? null,
        notes: teacherMonthlyRecord?.notes ?? teacherMetrics?.notes ?? null,
      },
      rows,
    };
  }

  async computeSalaryRecords(month: string) {
    const { monthStart, monthEnd } = monthToBounds(month);

    const rows = await this.repository.listTeacherMonthlyMetrics(monthStart, monthEnd);

    let updatedCount = 0;
    for (const row of rows) {
      if (row.hourly_rate === null || row.teacher_type === 'permanent') {
        continue;
      }

      if (row.salary_status === 'paid') {
        continue;
      }

      const hoursPlanned = roundHours(BillingRepository.toNumber(row.hours_planned));
      const hoursDone = roundHours(BillingRepository.toNumber(row.hours_done));
      const totalFcfa = Math.round(hoursDone * row.hourly_rate);
      const currentStatus = row.salary_status;

      const nextStatus: SalaryRecordStatus =
        currentStatus === 'disputed' ? 'disputed' : 'pending';

      await this.repository.upsertSalaryRecord({
        teacherId: row.teacher_id,
        periodMonth: monthStart,
        hoursPlanned,
        hoursDone,
        hourlyRate: row.hourly_rate,
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

    const updated = await this.repository.updateSalaryStatus({
      recordId: input.recordId,
      status: input.status,
      notes: input.notes,
      paidBy: input.status === 'paid' ? input.actor.userId : undefined,
    });

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
}

export const buildBillingService = (db: ConstructorParameters<typeof BillingRepository>[0]) =>
  new BillingService(new BillingRepository(db));
