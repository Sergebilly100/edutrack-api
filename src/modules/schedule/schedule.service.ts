import { randomBytes } from 'node:crypto';

import {
  createRoom,
  type Room,
  type RoomInsertInput,
  createSchedulePeriod,
  duplicatePeriodWithSchedules,
  findActiveSchedulePeriodByDate,
  findSchedulePeriodById,
  listSchedulesForPeriodAndDay,
  type ActiveSchedule,
  type QueryExecutor,
  type SchedulePeriod,
} from './schedule.repository.js';

export type ActiveSchedulesResult = {
  date: string;
  dayOfWeek: number;
  period: SchedulePeriod | null;
  schedules: ActiveSchedule[];
};

export type DuplicatePeriodInput = {
  newName: string;
  newValidFrom: string;
  newValidTo: string;
  createdBy: string | null;
};

const formatDate = (date: Date): string => date.toISOString().slice(0, 10);

const parseDateInput = (date: string | Date): Date => {
  if (date instanceof Date) {
    return date;
  }

  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Invalid date');
  }

  return parsed;
};

export const dayOfWeekFromDate = (date: Date): number => {
  const jsDay = date.getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
};

export const getActiveSchedulesForDate = async (
  db: QueryExecutor,
  dateInput: string | Date,
  teacherId?: string
): Promise<ActiveSchedulesResult> => {
  const date = parseDateInput(dateInput);
  const isoDate = formatDate(date);
  const dayOfWeek = dayOfWeekFromDate(date);

  const period = await findActiveSchedulePeriodByDate(db, isoDate);
  if (!period || dayOfWeek === 7) {
    return {
      date: isoDate,
      dayOfWeek,
      period,
      schedules: [],
    };
  }

  const schedules = await listSchedulesForPeriodAndDay(db, {
    periodId: period.id,
    dayOfWeek,
    date: isoDate,
    teacherId,
  });

  return {
    date: isoDate,
    dayOfWeek,
    period,
    schedules,
  };
};

export const duplicatePeriod = async (
  db: QueryExecutor,
  sourcePeriodId: string,
  newPeriod: DuplicatePeriodInput
): Promise<{ period: SchedulePeriod; copiedCount: number }> => {
  const sourcePeriod = await findSchedulePeriodById(db, sourcePeriodId);
  if (!sourcePeriod) {
    throw new Error('Source schedule period not found');
  }

  if (newPeriod.newValidFrom > newPeriod.newValidTo) {
    throw new Error('new_valid_from must be before or equal to new_valid_to');
  }

  return duplicatePeriodWithSchedules(db, sourcePeriodId, {
    name: newPeriod.newName,
    validFrom: newPeriod.newValidFrom,
    validTo: newPeriod.newValidTo,
    createdBy: newPeriod.createdBy,
  });
};

export const createPeriodFromInput = async (
  db: QueryExecutor,
  input: {
    name: string;
    validFrom: string;
    validTo: string;
    createdBy: string | null;
  }
): Promise<SchedulePeriod> => {
  if (input.validFrom > input.validTo) {
    throw new Error('valid_from must be before or equal to valid_to');
  }

  return createSchedulePeriod(db, input);
};

export const createRoomWithQrToken = async (
  db: QueryExecutor,
  input: Omit<RoomInsertInput, 'qrToken'>
): Promise<Room> => {
  const qrToken = randomBytes(32).toString('hex');
  return createRoom(db, { ...input, qrToken });
};
