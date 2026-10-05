import { afterEach, describe, expect, it, vi } from 'vitest';

import { monthlyAttendanceRates, ParentPortalService } from '../../src/modules/parent-portal/parent-portal.service.js';

describe('monthly parent attendance rates', () => {
  it.each([
    [{ present: 0, absent: 0, total: 0 }, 0, 100],
    [{ present: 20, absent: 0, total: 20 }, 0, 100],
    [{ present: 0, absent: 20, total: 20 }, 100, 0],
    // present, excused and late all count as recorded sessions; late is not absent.
    [{ present: 2, absent: 1, total: 4 }, 25, 50],
    [{ present: 0, absent: 8, total: 2 }, 100, 0],
    [{ present: -2, absent: -1, total: -4 }, 0, 100],
    [{ present: Number.NaN, absent: Number.POSITIVE_INFINITY, total: 3 }, 0, 0],
  ])('borne le détail %j à %i %% d’absence', (breakdown, absence, attendance) => {
    expect(monthlyAttendanceRates(breakdown)).toEqual({
      absenceRateMonth: absence,
      attendanceRateMonth: attendance,
    });
  });

  afterEach(() => vi.useRealTimers());

  it('interroge le premier et le dernier jour inclus du mois pour le taux explicite', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T12:00:00.000Z'));
    const repository = {
      parentCanAccessStudent: vi.fn().mockResolvedValue(true),
      countAbsencesForStudentInRange: vi.fn().mockResolvedValue(1),
      countAttendanceBreakdownForStudentMonth: vi.fn().mockResolvedValue({ present: 2, absent: 1, total: 4 }),
    };
    const service = new ParentPortalService(repository as never);
    const stats = await service.getStudentStats(
      { studentId: 'student-id' },
      { parentId: 'parent-id', allowedStudentIds: ['student-id'] }
    );
    expect(repository.countAttendanceBreakdownForStudentMonth).toHaveBeenCalledWith({
      studentId: 'student-id', monthStart: '2026-10-01', monthEnd: '2026-10-31',
    });
    expect(stats.absence_rate_month).toBe(25);
    expect(stats.attendance_rate_month).toBe(50);
  });
});
