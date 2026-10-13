import { beforeEach, describe, expect, it, vi } from 'vitest';

const repositoryMocks = vi.hoisted(() => ({
  createSchedulePeriod: vi.fn(),
  duplicatePeriodWithSchedules: vi.fn(),
  listScheduleCopyTargets: vi.fn().mockResolvedValue([]),
  isTeacherBlocked: vi.fn().mockResolvedValue(false),
  hasTeacherSubjectAssignment: vi.fn().mockResolvedValue(true),
  findAssignedScheduleSubject: vi.fn().mockResolvedValue({ id: 'subject-1', name: 'Maths' }),
  findActiveSchedulePeriodByDate: vi.fn(),
  findSchedulePeriodById: vi.fn(),
  findActiveScheduleSchoolYear: vi.fn(),
  listSchedulesForPeriodAndDay: vi.fn(),
  createRoom: vi.fn(),
}));

vi.mock('../../src/modules/schedule/schedule.repository.js', () => ({
  createSchedulePeriod: repositoryMocks.createSchedulePeriod,
  duplicatePeriodWithSchedules: repositoryMocks.duplicatePeriodWithSchedules,
  listScheduleCopyTargets: repositoryMocks.listScheduleCopyTargets,
  isTeacherBlocked: repositoryMocks.isTeacherBlocked,
  hasTeacherSubjectAssignment: repositoryMocks.hasTeacherSubjectAssignment,
  findAssignedScheduleSubject: repositoryMocks.findAssignedScheduleSubject,
  findActiveSchedulePeriodByDate: repositoryMocks.findActiveSchedulePeriodByDate,
  findSchedulePeriodById: repositoryMocks.findSchedulePeriodById,
  findActiveScheduleSchoolYear: repositoryMocks.findActiveScheduleSchoolYear,
  listSchedulesForPeriodAndDay: repositoryMocks.listSchedulesForPeriodAndDay,
  createRoom: repositoryMocks.createRoom,
}));

import {
  createPeriodFromInput,
  dayOfWeekFromDate,
  duplicatePeriod,
  getActiveSchedulesForDate,
  hasFutureOccurrenceInPeriod,
  assertScheduleWithinActiveYear,
  recurringScheduleCrossesSchoolYear,
} from '../../src/modules/schedule/schedule.service.js';

const db = { transaction: async (run: (tx: unknown) => Promise<unknown>) => run(db) } as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('schedule.service', () => {
  it('bloque un créneau pour une année ouverte mais encore future', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T08:00:00.000Z'));
    try {
      repositoryMocks.findActiveScheduleSchoolYear.mockResolvedValue({
        id: 'year-1', label: '2026-2027', startDate: '2026-09-01', endDate: '2027-06-30',
      });
      repositoryMocks.findSchedulePeriodById.mockResolvedValue({ valid_from: '2026-09-01', valid_to: '2027-06-30' });
      await expect(assertScheduleWithinActiveYear(db, '2026-09-07', 'period-1')).rejects.toMatchObject({
        code: 'SCHOOL_YEAR_NOT_OPEN',
      });
    } finally { vi.useRealTimers(); }
  });

  it('bloque un créneau après la fin de l’année active', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-07-01T08:00:00.000Z'));
    try {
      repositoryMocks.findActiveScheduleSchoolYear.mockResolvedValue({
        id: 'year-1', label: '2026-2027', startDate: '2026-09-01', endDate: '2027-06-30',
      });
      repositoryMocks.findSchedulePeriodById.mockResolvedValue({ valid_from: '2026-09-01', valid_to: '2027-06-30' });
      await expect(assertScheduleWithinActiveYear(db, '2027-06-29', 'period-1')).rejects.toMatchObject({
        code: 'SCHOOL_YEAR_FINISHED', message: 'Année scolaire 2026-2027 terminée.',
      });
    } finally { vi.useRealTimers(); }
  });

  it('refuse un créneau récurrent qui aurait une occurrence après la fin de l’année', () => {
    expect(recurringScheduleCrossesSchoolYear('2027-06-30', '2027-07-10', 1)).toBe(true);
    expect(recurringScheduleCrossesSchoolYear('2027-06-30', '2027-07-03', 1)).toBe(false);
  });
  it('dayOfWeekFromDate() mappe dimanche JS (0) vers 7', () => {
    const sunday = new Date('2026-04-12T00:00:00.000Z');
    expect(dayOfWeekFromDate(sunday)).toBe(7);
  });

  it('dayOfWeekFromDate() garde lundi=1 et samedi=6', () => {
    const monday = new Date('2026-04-13T00:00:00.000Z');
    const saturday = new Date('2026-04-11T00:00:00.000Z');

    expect(dayOfWeekFromDate(monday)).toBe(1);
    expect(dayOfWeekFromDate(saturday)).toBe(6);
  });

  it('getActiveSchedulesForDate() retourne schedules vides le dimanche', async () => {
    repositoryMocks.findActiveSchedulePeriodByDate.mockResolvedValue({
      id: 'period-1',
      name: 'Semaine 1',
      valid_from: '2026-04-06',
      valid_to: '2026-04-12',
      is_active: true,
      created_by: 'user-1',
      created_at: '2026-04-01T10:00:00.000Z',
    });

    const result = await getActiveSchedulesForDate(db, '2026-04-12');

    expect(result.dayOfWeek).toBe(7);
    expect(result.period).not.toBeNull();
    expect(result.schedules).toEqual([]);
    expect(repositoryMocks.listSchedulesForPeriodAndDay).not.toHaveBeenCalled();
  });

  it('getActiveSchedulesForDate() retourne period null et schedules vides si aucune période active', async () => {
    repositoryMocks.findActiveSchedulePeriodByDate.mockResolvedValue(null);

    const result = await getActiveSchedulesForDate(db, '2026-04-13');

    expect(result).toEqual({
      date: '2026-04-13',
      dayOfWeek: 1,
      period: null,
      schedules: [],
    });
    expect(repositoryMocks.listSchedulesForPeriodAndDay).not.toHaveBeenCalled();
  });

  it('getActiveSchedulesForDate() appelle listSchedulesForPeriodAndDay avec les bons paramètres', async () => {
    repositoryMocks.findActiveSchedulePeriodByDate.mockResolvedValue({
      id: 'period-2',
      name: 'Semaine 2',
      valid_from: '2026-04-13',
      valid_to: '2026-04-18',
      is_active: true,
      created_by: 'user-1',
      created_at: '2026-04-10T08:00:00.000Z',
    });
    repositoryMocks.listSchedulesForPeriodAndDay.mockResolvedValue([{
      id: 'sched-1', subject: 'Mathématiques', subjectId: 'subject-1', subjectAbbreviation: 'Maths',
      subjectReferences: [{ name: 'Mathématiques', abbreviation: 'Maths' }],
    }]);

    const result = await getActiveSchedulesForDate(db, '2026-04-13');

    expect(repositoryMocks.listSchedulesForPeriodAndDay).toHaveBeenCalledWith(db, {
      periodId: 'period-2',
      dayOfWeek: 1,
      date: '2026-04-13',
      teacherId: undefined,
    });
    expect(result.schedules).toEqual([{
      id: 'sched-1', subject: 'Mathématiques', subjectId: 'subject-1', subjectDisplay: 'Maths',
    }]);
  });

  it('getActiveSchedulesForDate() transmet teacherId quand fourni', async () => {
    repositoryMocks.findActiveSchedulePeriodByDate.mockResolvedValue({
      id: 'period-2',
      name: 'Semaine 2',
      valid_from: '2026-04-13',
      valid_to: '2026-04-18',
      is_active: true,
      created_by: 'user-1',
      created_at: '2026-04-10T08:00:00.000Z',
    });
    repositoryMocks.listSchedulesForPeriodAndDay.mockResolvedValue([]);

    await getActiveSchedulesForDate(db, '2026-04-13', 'teacher-1');

    expect(repositoryMocks.listSchedulesForPeriodAndDay).toHaveBeenCalledWith(db, {
      periodId: 'period-2',
      dayOfWeek: 1,
      date: '2026-04-13',
      teacherId: 'teacher-1',
    });
  });

  it("duplicatePeriod() lève si la source est introuvable", async () => {
    repositoryMocks.findSchedulePeriodById.mockResolvedValue(null);

    await expect(
      duplicatePeriod(db, 'missing', {
        newName: 'Copie',
        newValidFrom: '2026-04-20',
        newValidTo: '2026-04-25',
        createdBy: 'user-1',
      })
    ).rejects.toThrow('Source schedule period not found');
  });

  it('duplicatePeriod() lève si newValidFrom > newValidTo', async () => {
    repositoryMocks.findSchedulePeriodById.mockResolvedValue({ id: 'period-1' });

    await expect(
      duplicatePeriod(db, 'period-1', {
        newName: 'Copie',
        newValidFrom: '2026-04-26',
        newValidTo: '2026-04-25',
        createdBy: 'user-1',
      })
    ).rejects.toThrow('new_valid_from must be before or equal to new_valid_to');
  });

  it('duplicatePeriod() délègue à duplicatePeriodWithSchedules avec les bons paramètres', async () => {
    repositoryMocks.findSchedulePeriodById.mockResolvedValue({ id: 'period-1' });
    repositoryMocks.duplicatePeriodWithSchedules.mockResolvedValue({
      period: { id: 'period-2' },
      copiedCount: 5,
    });

    const result = await duplicatePeriod(db, 'period-1', {
      newName: 'Copie',
      newValidFrom: '2026-04-20',
      newValidTo: '2026-04-26',
      createdBy: 'user-1',
    });

    expect(repositoryMocks.duplicatePeriodWithSchedules).toHaveBeenCalledWith(db, 'period-1', {
      name: 'Copie',
      validFrom: '2026-04-20',
      validTo: '2026-04-26',
      createdBy: 'user-1',
    });
    expect(result).toEqual({ period: { id: 'period-2' }, copiedCount: 5 });
  });

  it('createPeriodFromInput() lève si validFrom > validTo', async () => {
    await expect(
      createPeriodFromInput(db, {
        name: 'Période',
        validFrom: '2026-04-30',
        validTo: '2026-04-01',
        createdBy: 'user-1',
      })
    ).rejects.toThrow('valid_from must be before or equal to valid_to');
  });

  it('createPeriodFromInput() délègue à createSchedulePeriod si dates valides', async () => {
    repositoryMocks.createSchedulePeriod.mockResolvedValue({ id: 'period-1' });

    const result = await createPeriodFromInput(db, {
      name: 'Période',
      validFrom: '2026-04-06',
      validTo: '2026-05-03',
      createdBy: 'user-1',
    });

    expect(repositoryMocks.createSchedulePeriod).toHaveBeenCalledWith(db, {
      name: 'Période',
      validFrom: '2026-04-06',
      validTo: '2026-05-03',
      createdBy: 'user-1',
    });
    expect(result).toEqual({ id: 'period-1' });
  });

  it('hasFutureOccurrenceInPeriod() retourne true avec startTime HH:MM', () => {
    const result = hasFutureOccurrenceInPeriod({
      validFrom: '2026-04-20',
      validTo: '2026-04-30',
      dayOfWeek: 4,
      startTime: '08:00',
      now: new Date('2026-04-22T06:00:00.000Z'),
    });

    expect(result).toBe(true);
  });

  it('hasFutureOccurrenceInPeriod() retourne false quand toutes les occurrences sont passées', () => {
    const result = hasFutureOccurrenceInPeriod({
      validFrom: '2026-04-01',
      validTo: '2026-04-21',
      dayOfWeek: 2,
      startTime: '08:00',
      now: new Date('2026-04-23T06:00:00.000Z'),
    });

    expect(result).toBe(false);
  });
});

describe('C10 schedule duplication', () => {
  it.each(['blocked', 'unassigned'])('rejects %s teachers before copying any schedule', async (state) => {
    repositoryMocks.findSchedulePeriodById.mockResolvedValue({ id: 'period-1' });
    repositoryMocks.listScheduleCopyTargets.mockResolvedValue([{ teacherId: 'teacher', classId: 'class', subject: 'Maths', subjectId: 'subject-1' }]);
    repositoryMocks.isTeacherBlocked.mockResolvedValue(state === 'blocked');
    repositoryMocks.findAssignedScheduleSubject.mockResolvedValue(state === 'blocked' ? { id: 'subject-1', name: 'Maths' } : null);
    await expect(duplicatePeriod(db, 'period-1', { newName: 'Copie', newValidFrom: '2026-10-05', newValidTo: '2026-11-01', createdBy: 'user' })).rejects.toThrow(state === 'blocked' ? 'Teacher is blocked' : 'Teacher must be assigned');
    expect(repositoryMocks.duplicatePeriodWithSchedules).not.toHaveBeenCalled();
  });
});
