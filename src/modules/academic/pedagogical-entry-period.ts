import type { GradingPeriodItem } from './academic-grading.types.js';

export type EntryPeriodCode =
  | 'NO_GRADING_PERIOD'
  | 'NEXT_GRADING_PERIOD_REQUIRED'
  | 'NEXT_SCHOOL_YEAR_REQUIRED'
  | 'GRADING_PERIOD_CALENDAR_INVALID'
  | 'GRADING_PERIOD_CLOSED'
  | 'FINAL_PERIOD_CALCULATION_STARTED'
  | 'SCHOOL_YEAR_NOT_STARTED';

export type EntryPeriodResolution =
  | { period: GradingPeriodItem; state: 'open'; code: null }
  | { period: null; state: 'unavailable'; code: EntryPeriodCode };

/** Résout uniquement les nouvelles activités. Une correction garde sa période enregistrée. */
export const resolvePedagogicalEntryPeriod = (
  periods: GradingPeriodItem[],
  date: string,
  classId: string,
  asOfDate = new Date().toISOString().slice(0, 10),
): EntryPeriodResolution => {
  const ordered = [...periods].sort((a, b) => a.orderIndex - b.orderIndex);
  if (ordered.length === 0) return { period: null, state: 'unavailable', code: 'NO_GRADING_PERIOD' };
  if (ordered.some((period, index) => {
    const previous = ordered[index - 1];
    return period.startDate > period.reviewStartDate || period.reviewStartDate > period.endDate
      || Boolean(previous && (period.orderIndex !== previous.orderIndex + 1
        || period.startDate <= previous.startDate
        || period.startDate > previous.reviewStartDate));
  })) return { period: null, state: 'unavailable', code: 'GRADING_PERIOD_CALENDAR_INVALID' };

  const finalPeriod = ordered[ordered.length - 1]!;
  if (finalPeriod.orderIndex === (finalPeriod.type === 'trimester' ? 3 : 2)
    && asOfDate >= finalPeriod.reviewStartDate) {
    return { period: null, state: 'unavailable', code: 'FINAL_PERIOD_CALCULATION_STARTED' };
  }

  const target = ordered.find((period) => period.startDate <= date && date < period.reviewStartDate);
  if (!target) return {
    period: null, state: 'unavailable',
    code: date < ordered[0]!.startDate ? 'NO_GRADING_PERIOD'
      : date >= finalPeriod.reviewStartDate && finalPeriod.orderIndex === (finalPeriod.type === 'trimester' ? 3 : 2)
        ? 'NEXT_SCHOOL_YEAR_REQUIRED' : 'NEXT_GRADING_PERIOD_REQUIRED',
  };
  if (target.isCompleted || target.closedClassIds.includes(classId)) return {
    period: null, state: 'unavailable', code: 'GRADING_PERIOD_CLOSED',
  };
  return { period: target, state: 'open', code: null };
};
