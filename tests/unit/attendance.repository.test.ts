import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';

import { AttendanceRepository } from '../../src/modules/attendance/attendance.repository.js';

describe('AttendanceRepository', () => {
  let mockDb: any;
  let repository: AttendanceRepository;

  beforeEach(() => {
    mockDb = {
      execute: vi.fn(),
      transaction: vi.fn(),
    };
    repository = new AttendanceRepository(mockDb);
  });

  describe('bulkUpsertStudentAttendance', () => {
    it('should issue a single bulk INSERT and return upsertedCount', async () => {
      // Bulk INSERT retourne autant de lignes que d'élèves
      mockDb.execute.mockResolvedValue({
        rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      });

      const params = {
        scheduleId: 'schedule-uuid',
        date: '2026-05-09',
        absentStudentIds: ['student-1', 'student-2'],
        markedByUserId: 'user-uuid',
        allStudentIds: ['student-1', 'student-2', 'student-3'],
      };

      const result = await repository.bulkUpsertStudentAttendance(params);

      // Un seul aller-retour DB (pas de transaction loop)
      expect(mockDb.execute).toHaveBeenCalledTimes(1);
      expect(result.upsertedCount).toBe(3);
    });

    it('should propagate DB errors', async () => {
      mockDb.execute.mockRejectedValue(new Error('DB error'));

      const params = {
        scheduleId: 'schedule-uuid',
        date: '2026-05-09',
        absentStudentIds: ['student-1'],
        markedByUserId: 'user-uuid',
        allStudentIds: ['student-1', 'student-2'],
      };

      await expect(repository.bulkUpsertStudentAttendance(params)).rejects.toThrow('DB error');
    });

    it('should return 0 if no students', async () => {
      const params = {
        scheduleId: 'schedule-uuid',
        date: '2026-05-09',
        absentStudentIds: [],
        markedByUserId: 'user-uuid',
        allStudentIds: [],
      };

      const result = await repository.bulkUpsertStudentAttendance(params);

      expect(result.upsertedCount).toBe(0);
      expect(mockDb.execute).not.toHaveBeenCalled();
    });

    it('should pass correct statuses in the bulk INSERT payload', async () => {
      mockDb.execute.mockResolvedValue({ rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });

      const params = {
        scheduleId: 'schedule-uuid',
        date: '2026-05-09',
        absentStudentIds: ['student-1'],
        markedByUserId: 'user-uuid',
        allStudentIds: ['student-1', 'student-2', 'student-3'],
      };

      await repository.bulkUpsertStudentAttendance(params);

      const [queryArg] = mockDb.execute.mock.calls[0] as [any];
      // Le payload SQL doit contenir les deux statuts
      const sqlString = JSON.stringify(queryArg);
      expect(sqlString).toContain('absent');
      expect(sqlString).toContain('present');
    });
  });

  describe('logQrInvalidAlert', () => {
    it('should execute two queries: select director then insert notification', async () => {
      mockDb.execute.mockResolvedValueOnce({
        rows: [{ director_phone: '+2250700000000', director_email: 'dir@school.ci' }],
      }).mockResolvedValueOnce({ rows: [] });

      await repository.logQrInvalidAlert({
        teacherId: 'teacher-uuid',
        teacherName: 'Diallo Ibrahim',
        qrToken: 'invalid-token',
        timestamp: '2026-05-09T08:00:00Z',
      });

      // Two DB calls: 1) find director, 2) insert notification_log
      expect(mockDb.execute).toHaveBeenCalledTimes(2);
    });
  });
});
