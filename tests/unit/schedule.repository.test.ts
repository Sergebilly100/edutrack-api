import { describe, it, expect, beforeEach, vi } from 'vitest';
import { findOrCreateTimeSlot } from '../../src/modules/schedule/schedule.repository.js';

describe('Schedule Repository', () => {
  let mockDb: any;

  beforeEach(() => {
    mockDb = {
      execute: vi.fn(),
    };
  });

  describe('findOrCreateTimeSlot', () => {
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
      const queryStr = query.queryChunks.join('');

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
});
