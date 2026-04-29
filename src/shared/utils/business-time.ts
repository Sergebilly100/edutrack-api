export const TIMEZONE_METIER = 'Africa/Abidjan';

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE_METIER,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const monthFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE_METIER,
  year: 'numeric',
  month: '2-digit',
});

const toIsoDateParts = (value: Date): { year: number; month: number; day: number } => {
  const parts = dateFormatter.formatToParts(value);
  const year = Number(parts.find((item) => item.type === 'year')?.value ?? '1970');
  const month = Number(parts.find((item) => item.type === 'month')?.value ?? '01');
  const day = Number(parts.find((item) => item.type === 'day')?.value ?? '01');
  return { year, month, day };
};

export const todayInBusinessTimezone = (value = new Date()): string => {
  return dateFormatter.format(value);
};

export const monthKeyInBusinessTimezone = (value = new Date()): string => {
  const parts = monthFormatter.formatToParts(value);
  const year = parts.find((item) => item.type === 'year')?.value ?? '1970';
  const month = parts.find((item) => item.type === 'month')?.value ?? '01';
  return `${year}-${month}`;
};

export const addDaysIso = (isoDate: string, days: number): string => {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

export const addMonthsIso = (isoDate: string, months: number): string => {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
};

export const businessDateFromNowPlusDays = (days: number, value = new Date()): string => {
  const { year, month, day } = toIsoDateParts(value);
  const base = new Date(Date.UTC(year, month - 1, day));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
};
