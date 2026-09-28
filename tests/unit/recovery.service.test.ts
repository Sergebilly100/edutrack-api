import { describe, expect, it, vi } from 'vitest';
import { RecoveryService, summarizeRecovery } from '../../src/modules/finance/recovery.service.js';
import type { RecoveryRepository, RecoveryClassRow } from '../../src/modules/finance/recovery.repository.js';

const classRow = (overrides: Partial<RecoveryClassRow> = {}): RecoveryClassRow => ({
  class_id: 'class-1', class_name: '6e A', level_id: 'level-1', level_name: '6e',
  student_count: 2, expected: '100000', paid: '40000', waived: '50000',
  remaining: '10000', students_to_follow: 1, ...overrides,
});

describe('recovery indicators', () => {
  it('keeps school waivers separate from collected cash and the recovery rate', () => {
    expect(summarizeRecovery([classRow()])).toEqual({
      studentCount: 2, expected: 100000, paid: 40000, waived: 50000,
      remaining: 10000, recoveryRate: 0.4, studentsToFollow: 1,
    });
  });

  it('aggregates classes into levels and keeps the school independent of filters', async () => {
    const repository = {
      yearExists: vi.fn().mockResolvedValue(true),
      levelExists: vi.fn().mockResolvedValue(true),
      classExists: vi.fn().mockResolvedValue(true),
      listClasses: vi.fn().mockResolvedValue([
        classRow(), classRow({ class_id: 'class-2', class_name: '5e A', level_id: 'level-2', level_name: '5e', paid: '100000', waived: '0', remaining: '0', students_to_follow: 0 }),
      ]),
    };
    const service = new RecoveryService(repository as unknown as RecoveryRepository);
    const result = await service.getSummary('year', 'level-1');
    expect(result.school).toMatchObject({ studentCount: 4, paid: 140000, waived: 50000 });
    expect(result.selection).toMatchObject({ studentCount: 2, paid: 40000, recoveryRate: 0.4 });
    expect(result.levels).toHaveLength(1);
    expect(result.classes).toHaveLength(1);
  });

  it('rejects a class outside the requested year or level', async () => {
    const repository = {
      yearExists: vi.fn().mockResolvedValue(true),
      levelExists: vi.fn().mockResolvedValue(true),
      classExists: vi.fn().mockResolvedValue(false),
    };
    await expect(new RecoveryService(repository as unknown as RecoveryRepository)
      .getSummary('year', 'level', 'foreign-class')).rejects.toMatchObject({
        statusCode: 400, code: 'RECOVERY_CLASS_OUT_OF_SCOPE',
      });
  });
});
