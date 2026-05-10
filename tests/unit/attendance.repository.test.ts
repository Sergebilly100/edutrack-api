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
    it('should use transaction to ensure atomicity', async () => {
      const mockTx = {
        execute: vi.fn().mockResolvedValue({ rows: [] }),
      };

      mockDb.transaction.mockImplementation(async (callback: any) => {
        return callback(mockTx);
      });

      const params = {
        scheduleId: 'schedule-uuid',
        date: '2026-05-09',
        absentStudentIds: ['student-1', 'student-2'],
        markedByUserId: 'user-uuid',
        allStudentIds: ['student-1', 'student-2', 'student-3'],
      };

      const result = await repository.bulkUpsertStudentAttendance(params);

      // Vérifie que la transaction a été appelée
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);

      // Vérifie que toutes les requêtes ont été exécutées dans la transaction
      expect(mockTx.execute).toHaveBeenCalledTimes(3);

      // Vérifie le résultat
      expect(result.upsertedCount).toBe(3);
    });

    it('should rollback on error', async () => {
      const mockTx = {
        execute: vi.fn()
          .mockResolvedValueOnce({ rows: [] })
          .mockRejectedValueOnce(new Error('DB error')),
      };

      mockDb.transaction.mockImplementation(async (callback: any) => {
        return callback(mockTx);
      });

      const params = {
        scheduleId: 'schedule-uuid',
        date: '2026-05-09',
        absentStudentIds: ['student-1'],
        markedByUserId: 'user-uuid',
        allStudentIds: ['student-1', 'student-2'],
      };

      // La transaction doit propager l'erreur
      await expect(repository.bulkUpsertStudentAttendance(params)).rejects.toThrow('DB error');

      // Vérifie que le 2e upsert a échoué
      expect(mockTx.execute).toHaveBeenCalledTimes(2);
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
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it('should mark students as present if not in absentStudentIds', async () => {
      const mockTx = {
        execute: vi.fn().mockResolvedValue({ rows: [] }),
      };

      mockDb.transaction.mockImplementation(async (callback: any) => {
        return callback(mockTx);
      });

      const params = {
        scheduleId: 'schedule-uuid',
        date: '2026-05-09',
        absentStudentIds: ['student-1'],
        markedByUserId: 'user-uuid',
        allStudentIds: ['student-1', 'student-2', 'student-3'],
      };

      await repository.bulkUpsertStudentAttendance(params);

      // Vérifie les appels avec les bons statuts
      const calls = mockTx.execute.mock.calls;

      // student-1 → absent
      expect(calls[0][0].queryChunks.some((chunk: any) =>
        chunk.toString().includes('absent')
      )).toBe(true);

      // student-2 et student-3 → present
      expect(calls[1][0].queryChunks.some((chunk: any) =>
        chunk.toString().includes('present')
      )).toBe(true);
    });
  });

  describe('logQrInvalidAlert', () => {
    it('should filter director by tenant', async () => {
      mockDb.execute.mockResolvedValueOnce({
        rows: [{ director_phone: '+2250700000000', director_email: 'dir@school.ci' }],
      }).mockResolvedValueOnce({ rows: [] });

      await repository.logQrInvalidAlert({
        teacherId: 'teacher-uuid',
        teacherName: 'Diallo Ibrahim',
        qrToken: 'invalid-token',
        timestamp: '2026-05-09T08:00:00Z',
      });

      // Vérifie que la query SELECT contient un EXISTS sur teachers
      const selectCall = mockDb.execute.mock.calls[0][0];
      const queryStr = selectCall.queryChunks.join('');

      expect(queryStr).toContain('EXISTS');
      expect(queryStr).toContain('teachers');
    });
  });
});
