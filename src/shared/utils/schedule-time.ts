import { z } from 'zod';

/** Minutes since midnight for a complete 24-hour HH:MM value. */
export const parseScheduleTime = (value: string): number | null => {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
};

export const isValidScheduleInterval = (start: string, end: string): boolean => {
  const startMinutes = parseScheduleTime(start);
  const endMinutes = parseScheduleTime(end);
  return startMinutes !== null && endMinutes !== null && startMinutes < endMinutes;
};

export const scheduleTimeSchema = z.string().refine(
  (value) => parseScheduleTime(value) !== null,
  'Invalid time - expected HH:MM between 00:00 and 23:59'
);
