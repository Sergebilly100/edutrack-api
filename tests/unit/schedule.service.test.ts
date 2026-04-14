import { beforeEach, describe, expect, it, vi } from 'vitest';

const repositoryMocks = vi.hoisted(() => ({
  createSchedulePeriod: vi.fn(),
  duplicatePeriodWithSchedules: vi.fn(),
  findActiveSchedulePeriodByDate: vi.fn(),
  findSchedulePeriodById: vi.fn(),
  listSchedulesForPeriodAndDay: vi.fn(),
  createRoom: vi.fn(),
}));

vi.mock('../../src/modules/schedule/schedule.repository.js', () => ({
  createSchedulePeriod: repositoryMocks.createSchedulePeriod,
  duplicatePeriodWithSchedules: repositoryMocks.duplicatePeriodWithSchedules,
  findActiveSchedulePeriodByDate: repositoryMocks.findActiveSchedulePeriodByDate,
  findSchedulePeriodById: repositoryMocks.findSchedulePeriodById,
  listSchedulesForPeriodAndDay: repositoryMocks.listSchedulesForPeriodAndDay,
  createRoom: repositoryMocks.createRoom,
}));

import {
  createPeriodFromInput,
  dayOfWeekFromDate,
  duplicatePeriod,
  getActiveSchedulesForDate,
} from '../../src/modules/schedule/schedule.service.js';

const db = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('schedule.service', () => {
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
    repositoryMocks.listSchedulesForPeriodAndDay.mockResolvedValue([{ id: 'sched-1' }]);

    const result = await getActiveSchedulesForDate(db, '2026-04-13');

    expect(repositoryMocks.listSchedulesForPeriodAndDay).toHaveBeenCalledWith(db, {
      periodId: 'period-2',
      dayOfWeek: 1,
      date: '2026-04-13',
      teacherId: undefined,
    });
    expect(result.schedules).toEqual([{ id: 'sched-1' }]);
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
      newValidTo: '2026-04-25',
      createdBy: 'user-1',
    });

    expect(repositoryMocks.duplicatePeriodWithSchedules).toHaveBeenCalledWith(db, 'period-1', {
      name: 'Copie',
      validFrom: '2026-04-20',
      validTo: '2026-04-25',
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
      validFrom: '2026-04-01',
      validTo: '2026-04-30',
      createdBy: 'user-1',
    });

    expect(repositoryMocks.createSchedulePeriod).toHaveBeenCalledWith(db, {
      name: 'Période',
      validFrom: '2026-04-01',
      validTo: '2026-04-30',
      createdBy: 'user-1',
    });
    expect(result).toEqual({ id: 'period-1' });
  });
});
