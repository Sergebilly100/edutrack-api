import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  findOrCreateTimeSlot,
  findScheduleConflicts,
  listClassesCatalog,
  listSchedulesForPeriod,
  listSchedulesForPeriodAndDay,
} from '../../src/modules/schedule/schedule.repository.js';

describe('Schedule Repository', () => {
  let mockDb: any;

  beforeEach(() => {
    mockDb = {
      execute: vi.fn(),
    };
  });

  describe('findOrCreateTimeSlot', () => {
    it('keeps exact flexible times in the time slot lookup', async () => {
      mockDb.execute.mockResolvedValue({ rows: [{ id: 'flex-slot', label: '07:15 – 08:05', start_time: '07:15:00', end_time: '08:05:00', sort_order: 435 }] });
      const slot = await findOrCreateTimeSlot(mockDb, { startTime: '07:15', endTime: '08:05' });
      expect(slot).toMatchObject({ id: 'flex-slot', sortOrder: 435, startTime: '07:15:00', endTime: '08:05:00' });
    });
    it('should return existing time_slot if found', async () => {
      mockDb.execute.mockResolvedValue({
        rows: [{
          id: 'existing-slot-uuid',
          label: '08:00 – 09:30',
          start_time: '08:00',
          end_time: '09:30',
          sort_order: 480,
        }],
      });

      const result = await findOrCreateTimeSlot(mockDb, {
        startTime: '08:00',
        endTime: '09:30',
      });

      expect(result.id).toBe('existing-slot-uuid');
      expect(result.startTime).toBe('08:00');
      expect(result.endTime).toBe('09:30');
      expect(result.sortOrder).toBe(480);
    });

    it('should create time_slot if not found', async () => {
      mockDb.execute.mockResolvedValue({
        rows: [{
          id: 'new-slot-uuid',
          label: '14:00 – 15:30',
          start_time: '14:00',
          end_time: '15:30',
          sort_order: 840,
        }],
      });

      const result = await findOrCreateTimeSlot(mockDb, {
        startTime: '14:00',
        endTime: '15:30',
      });

      expect(result.id).toBe('new-slot-uuid');
      expect(result.label).toBe('14:00 – 15:30');

      // Vérifie le calcul du sort_order : 14*60 = 840
      expect(result.sortOrder).toBe(840);
    });

    it('should use ON CONFLICT for idempotency', async () => {
      mockDb.execute.mockResolvedValue({
        rows: [{
          id: 'slot-uuid',
          label: '10:00 – 11:00',
          start_time: '10:00',
          end_time: '11:00',
          sort_order: 600,
        }],
      });

      await findOrCreateTimeSlot(mockDb, {
        startTime: '10:00',
        endTime: '11:00',
      });

      const query = mockDb.execute.mock.calls[0][0];
      const queryStr = query.queryChunks
        .flatMap((c: { value?: string[] }) => (Array.isArray(c.value) ? c.value : []))
        .join('');

      expect(queryStr).toContain('ON CONFLICT');
    });

    it('should throw if no result returned', async () => {
      mockDb.execute.mockResolvedValue({
        rows: [],
      });

      await expect(
        findOrCreateTimeSlot(mockDb, {
          startTime: '07:00',
          endTime: '08:00',
        })
      ).rejects.toThrow('failed to upsert time_slot');
    });
  });

  it('compares real half-open intervals for teacher, room and class conflicts', async () => {
    mockDb.execute.mockResolvedValue({ rows: [{ teacher_conflict: true, room_conflict: false, class_conflict: true }] });
    const conflicts = await findScheduleConflicts(mockDb, {
      schedulePeriodId: '11111111-1111-4111-8111-111111111111',
      teacherId: '22222222-2222-4222-8222-222222222222',
      classId: '33333333-3333-4333-8333-333333333333',
      roomId: '44444444-4444-4444-8444-444444444444',
      timeSlotId: '55555555-5555-4555-8555-555555555555',
      dayOfWeek: 1, subject: 'Maths', referenceDate: '2099-01-05',
    });
    expect(conflicts).toEqual({ teacherConflict: true, roomConflict: false, classConflict: true });
    const query = mockDb.execute.mock.calls[0][0].queryChunks
      .flatMap((chunk: { value?: string[] } | null) => chunk?.value ?? []).join('');
    expect(query.match(/existing_slot\.start_time < target_slot\.end_time/g)).toHaveLength(3);
    expect(query.match(/existing_slot\.end_time > target_slot\.start_time/g)).toHaveLength(3);
  });

  describe('catalogue et créneaux avec niveau', () => {
    const queryText = (query: { queryChunks: Array<{ value?: string[] }> }) =>
      query.queryChunks.flatMap((chunk) => Array.isArray(chunk.value) ? chunk.value : []).join('');

    it('projette le niveau du catalogue et conserve les classes sans niveau', async () => {
      mockDb.execute.mockResolvedValue({ rows: [
        { id: 'c1', name: '6A', level_id: 'l6', level_name: '6ème' },
        { id: 'c2', name: 'Ancienne classe', level_id: null, level_name: null },
      ] });

      expect(await listClassesCatalog(mockDb)).toEqual([
        { id: 'c1', name: '6A', levelId: 'l6', levelName: '6ème' },
        { id: 'c2', name: 'Ancienne classe', levelId: null, levelName: null },
      ]);
      const query = queryText(mockDb.execute.mock.calls[0][0]);
      expect(query).toContain('LEFT JOIN levels l ON l.id = c.level_id');
      expect(query).toContain('ORDER BY l.order_index ASC NULLS LAST');
    });

    it.each([
      ['daily', () => listSchedulesForPeriodAndDay(mockDb, { periodId: 'p1', date: '2026-10-05', dayOfWeek: 1 })],
      ['weekly', () => listSchedulesForPeriod(mockDb, { periodId: 'p1', date: '2026-10-05', weekStart: '2026-10-05', weekEnd: '2026-10-10' })],
    ])('projette le niveau des créneaux %s', async (_label, run) => {
      mockDb.execute.mockResolvedValue({ rows: [
        { id: 's1', class_id: 'c1', class_name: '6A', class_level_id: 'l6', class_level_name: '6ème', level_subjects: [] },
        { id: 's2', class_id: 'c2', class_name: 'Ancienne classe', class_level_id: null, class_level_name: null, level_subjects: [] },
      ] });
      const schedules = await run();
      expect(schedules.map((schedule) => schedule.class)).toEqual([
        { id: 'c1', name: '6A', levelId: 'l6', levelName: '6ème' },
        { id: 'c2', name: 'Ancienne classe', levelId: null, levelName: null },
      ]);
      const query = queryText(mockDb.execute.mock.calls[0][0]);
      expect(query).toContain('c.level_id::text AS class_level_id');
      expect(query).toContain('l.name AS class_level_name');
      expect(query).toContain('LEFT JOIN levels l ON l.id = c.level_id');
    });
  });
});
