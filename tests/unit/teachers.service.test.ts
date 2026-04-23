import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TeachersModuleError, TeachersService } from '../../src/modules/teachers/teachers.service.js';

const repository = {
  listTeachers: vi.fn(),
  getTeacherById: vi.fn(),
  countActiveUsers: vi.fn(),
  createTeacher: vi.fn(),
  updateTeacher: vi.fn(),
  softDeleteTeacher: vi.fn(),
  getTeacherStats: vi.fn(),
  getAttendanceStats: vi.fn(),
  hasOutstandingUnpaidSalaryRecords: vi.fn(),
};

const baseTeacher = {
  id: 'teacher-1',
  user_id: 'user-1',
  name: 'M. Diallo',
  first_name: 'M.',
  last_name: 'Diallo',
  phone: '2250701234567',
  type: 'vacataire' as const,
  subjects: ['Maths'],
  hourly_rate: 5000,
  monthly_salary: null,
  is_active: true,
  is_blocked: false,
  blocked_reason: null,
  blocked_at: null,
  username: 'diallo.m',
  created_at: new Date('2026-01-01T00:00:00.000Z'),
};

describe('teachers.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('bloque le changement de type si des salaires ne sont pas payés', async () => {
    repository.getTeacherById.mockResolvedValue(baseTeacher);
    repository.hasOutstandingUnpaidSalaryRecords.mockResolvedValue(true);

    const service = new TeachersService(repository as never);

    await expect(
      service.updateTeacher(baseTeacher.id, {
        type: 'permanent',
        monthly_salary: 400000,
      })
    ).rejects.toMatchObject<Partial<TeachersModuleError>>({
      code: 'TEACHER_TYPE_CHANGE_BLOCKED',
      statusCode: 409,
    });
  });

  it('autorise le changement de type si tous les salaires sont payés', async () => {
    repository.getTeacherById.mockResolvedValue(baseTeacher);
    repository.hasOutstandingUnpaidSalaryRecords.mockResolvedValue(false);
    repository.updateTeacher.mockResolvedValue({
      ...baseTeacher,
      type: 'permanent',
      hourly_rate: null,
      monthly_salary: 400000,
    });

    const service = new TeachersService(repository as never);

    const result = await service.updateTeacher(baseTeacher.id, {
      type: 'permanent',
      monthly_salary: 400000,
    });

    expect(repository.updateTeacher).toHaveBeenCalledWith(
      baseTeacher.id,
      expect.objectContaining({
        type: 'permanent',
        hourly_rate: null,
        monthly_salary: 400000,
      })
    );
    expect(result.type).toBe('permanent');
    expect(result.hourly_rate).toBeNull();
    expect(result.monthly_salary).toBe(400000);
  });
});
