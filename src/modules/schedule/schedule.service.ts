import { randomBytes } from 'node:crypto';

import {
  createRoom,
  listClassesCatalog,
  listRooms,
  listSchedulesForPeriod,
  listTeachersCatalog,
  listTimeSlotsCatalog,
  type Room,
  type RoomInsertInput,
  type ClassCatalogItem,
  createSchedulePeriod,
  duplicatePeriodWithSchedules,
  findActiveSchedulePeriodByDate,
  findActiveSchedulePeriodByWeek,
  findSchedulePeriodById,
  listSchedulesForPeriodAndDay,
  type ActiveSchedule,
  type QueryExecutor,
  type SchedulePeriod,
  type TeacherCatalogItem,
  type TimeSlotCatalogItem,
  // FIX BUG 3 — Nouvelles fonctions repository à ajouter (voir note ci-dessous)
  findOrCreateTimeSlot,
} from './schedule.repository.js';

export type ActiveSchedulesResult = {
  date: string;
  dayOfWeek: number;
  period: SchedulePeriod | null;
  schedules: ActiveSchedule[];
};

export type WeeklySchedulesResult = {
  date: string;
  period: SchedulePeriod | null;
  schedules: ActiveSchedule[];
  teachers: TeacherCatalogItem[];
  classes: ClassCatalogItem[];
  rooms: Room[];
  timeSlots: TimeSlotCatalogItem[];
};

export type DuplicatePeriodInput = {
  newName: string;
  newValidFrom: string;
  newValidTo: string;
  createdBy: string | null;
};

/**
 * FIX BUG 3 — Input étendu pour la création d'un créneau avec horaires libres.
 *
 * Deux modes exclusifs :
 * - `timeSlotId` renseigné → on utilise ce time_slot directement (backward compat)
 * - `startTime` + `endTime` renseignés → on cherche ou crée le time_slot
 */
export type CreateScheduleInput = {
  schedulePeriodId: string;
  teacherId: string;
  classId: string;
  roomId: string;
  dayOfWeek: number;
  subject: string;
  isActive?: boolean;
} & (
  | { timeSlotId: string; startTime?: never; endTime?: never }
  | { timeSlotId?: never; startTime: string; endTime: string }
);

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

const parseUtcDate = (date: string): Date => new Date(`${date}T00:00:00.000Z`);

const formatUtcDate = (value: Date): string => value.toISOString().slice(0, 10);

const toUtcDateTime = (dateIso: string, time: string): Date => {
  const parts = time.split(':');
  const hours = Number(parts[0] ?? 0);
  const minutes = Number(parts[1] ?? 0);
  const seconds = Number(parts[2] ?? 0);
  return new Date(Date.UTC(
    Number(dateIso.slice(0, 4)),
    Number(dateIso.slice(5, 7)) - 1,
    Number(dateIso.slice(8, 10)),
    Number.isFinite(hours) ? hours : 0,
    Number.isFinite(minutes) ? minutes : 0,
    Number.isFinite(seconds) ? seconds : 0
  ));
};

const nextIsoDayOnOrAfter = (base: Date, dayOfWeek: number): Date => {
  const baseIsoDay = dayOfWeekFromDate(base);
  const delta = (dayOfWeek - baseIsoDay + 7) % 7;
  const next = new Date(base);
  next.setUTCDate(next.getUTCDate() + delta);
  return next;
};

export const hasFutureOccurrenceInPeriod = (input: {
  validFrom: string;
  validTo: string;
  dayOfWeek: number;
  startTime: string;
  now?: Date;
}): boolean => {
  const now = input.now ?? new Date();
  const nowDateIso = formatUtcDate(now);
  const baseDateIso = input.validFrom > nowDateIso ? input.validFrom : nowDateIso;
  const periodEnd = parseUtcDate(input.validTo);
  let candidateDate = nextIsoDayOnOrAfter(parseUtcDate(baseDateIso), input.dayOfWeek);

  while (candidateDate <= periodEnd) {
    const candidateIsoDate = formatUtcDate(candidateDate);
    const candidateDateTime = toUtcDateTime(candidateIsoDate, input.startTime);
    if (candidateDateTime > now) {
      return true;
    }

    const nextWeek = new Date(candidateDate);
    nextWeek.setUTCDate(nextWeek.getUTCDate() + 7);
    candidateDate = nextWeek;
  }

  return false;
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

export const getWeeklySchedulesForDate = async (
  db: QueryExecutor,
  dateInput: string | Date
): Promise<WeeklySchedulesResult> => {
  const date = parseDateInput(dateInput);
  const isoDate = formatDate(date);
  const weekStartDate = new Date(date);
  const currentIsoDay = dayOfWeekFromDate(weekStartDate);
  weekStartDate.setUTCDate(weekStartDate.getUTCDate() - (currentIsoDay - 1));
  const weekEndDate = new Date(weekStartDate);
  weekEndDate.setUTCDate(weekEndDate.getUTCDate() + 5);
  const weekStart = formatDate(weekStartDate);
  const weekEnd = formatDate(weekEndDate);

  const [period, teachers, classes, rooms, timeSlots] = await Promise.all([
    findActiveSchedulePeriodByWeek(db, weekStart, weekEnd),
    listTeachersCatalog(db),
    listClassesCatalog(db),
    listRooms(db),
    listTimeSlotsCatalog(db),
  ]);

  if (!period) {
    return {
      date: isoDate,
      period: null,
      schedules: [],
      teachers,
      classes,
      rooms: rooms.filter((room) => room.isActive),
      timeSlots,
    };
  }

  const schedules = await listSchedulesForPeriod(db, {
    periodId: period.id,
    date: isoDate,
    weekStart,
    weekEnd,
  });

  return {
    date: isoDate,
    period,
    schedules,
    teachers,
    classes,
    rooms: rooms.filter((room) => room.isActive),
    timeSlots,
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

/**
 * FIX BUG 3 — Crée un créneau avec résolution automatique du time_slot.
 *
 * Si `timeSlotId` est fourni → utilisation directe.
 * Sinon, on résout via `startTime` + `endTime` :
 *   1. Cherche un time_slot existant avec ces horaires exacts.
 *   2. Si non trouvé, le crée avec le label "HH:MM – HH:MM" et sort_order
 *      calculé depuis startTime (minutes depuis minuit).
 */
export const resolveTimeSlotId = async (
  db: QueryExecutor,
  input: { timeSlotId?: string; startTime?: string; endTime?: string }
): Promise<string> => {
  if (input.timeSlotId) {
    return input.timeSlotId;
  }

  if (!input.startTime || !input.endTime) {
    throw new Error('Either timeSlotId or both startTime and endTime must be provided');
  }

  if (input.startTime >= input.endTime) {
    throw new Error('startTime must be before endTime');
  }

  const timeSlot = await findOrCreateTimeSlot(db, {
    startTime: input.startTime,
    endTime: input.endTime,
  });

  return timeSlot.id;
};
