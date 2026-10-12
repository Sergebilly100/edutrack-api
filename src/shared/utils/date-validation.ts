import { z } from 'zod';
import { todayInBusinessTimezone } from './business-time.js';

/** A calendar date, independent of the server's local timezone. */
export const isCivilDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

export const civilDateSchema = z.string().refine(isCivilDate, 'Date invalide : utilisez une date réelle au format AAAA-MM-JJ.');
export const civilMonthSchema = z.string().regex(/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/, 'Mois invalide : utilisez AAAA-MM.');

export const isCivilWeek = (value: string): boolean => {
  const match = /^(\d{4})-W(\d{2})$/.exec(value);
  if (!match || match[1] === '0000') return false;
  const year = Number(match[1]);
  const week = Number(match[2]);
  const januaryFourth = new Date(0);
  januaryFourth.setUTCFullYear(year, 0, 4);
  const januaryFourthNext = new Date(0);
  januaryFourthNext.setUTCFullYear(year + 1, 0, 4);
  const firstMonday = januaryFourth.getTime() - (januaryFourth.getUTCDay() + 6) % 7 * 86_400_000;
  const nextFirstMonday = januaryFourthNext.getTime() - (januaryFourthNext.getUTCDay() + 6) % 7 * 86_400_000;
  const weeksInYear = (nextFirstMonday - firstMonday) / (7 * 86_400_000);
  return week >= 1 && week <= weeksInYear;
};

export const civilWeekSchema = z.string().refine(isCivilWeek, 'Semaine invalide : utilisez AAAA-Www.');

export const isOrderedDateRange = (from: string | undefined, to: string | undefined, inclusive = true): boolean =>
  !from || !to || (inclusive ? from <= to : from < to);

export const orderedDateRange = <T extends Record<string, unknown>>(
  fromKey: keyof T,
  toKey: keyof T,
  inclusive = true,
) => (value: T, context: z.RefinementCtx): void => {
  const from = value[fromKey];
  const to = value[toKey];
  if (typeof from === 'string' && typeof to === 'string' && !isOrderedDateRange(from, to, inclusive)) {
    context.addIssue({ code: 'custom', path: [String(toKey)], message: inclusive
      ? 'La date de fin doit être postérieure ou égale à la date de début.'
      : 'La date de fin doit être postérieure à la date de début.' });
  }
};

export const birthDateIssue = (value: string, now = new Date()): string | null => {
  if (!isCivilDate(value)) return 'Date de naissance invalide : indiquez une date réelle au format AAAA-MM-JJ.';
  if (value >= todayInBusinessTimezone(now)) return 'La date de naissance doit être antérieure à aujourd’hui.';
  return null;
};

export const studentBirthDateSchema = z.string().superRefine((value, context) => {
  const message = birthDateIssue(value);
  if (message) context.addIssue({ code: 'custom', message });
});

export const optionalStudentBirthDateSchema = z.string().superRefine((value, context) => {
  const message = value ? birthDateIssue(value) : null;
  if (message) context.addIssue({ code: 'custom', message });
});

export const dateValidationProblem = (error: z.ZodError): { error: string; code: string; statusCode: 400 } | null => {
  const issue = error.issues.find((item) => item.message.startsWith('Date de naissance')
    || item.message.startsWith('La date de naissance'));
  if (issue) return { error: issue.message, code: 'INVALID_BIRTH_DATE', statusCode: 400 };
  const range = error.issues.find((item) => item.message.startsWith('La date de fin') || item.message.startsWith('Le début de revue'));
  if (range) return { error: range.message, code: 'INVALID_DATE_RANGE', statusCode: 400 };
  const civil = error.issues.find((item) => item.message.startsWith('Date invalide') || item.message.startsWith('Mois invalide') || item.message.startsWith('Semaine invalide'));
  if (civil) return { error: civil.message, code: 'INVALID_CIVIL_DATE', statusCode: 400 };
  return null;
};
