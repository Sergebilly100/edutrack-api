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

const basePermanent = {
  ...baseTeacher,
  id: 'teacher-perm-1',
  name: 'Mme Coulibaly',
  type: 'permanent' as const,
  hourly_rate: null,
  monthly_salary: 400000,
};

describe('teachers.service', () => {
  let service: TeachersService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new TeachersService(repository as never);
  });

  // ── listTeachers ──────────────────────────────────────────────────────────

  describe('listTeachers', () => {
    it('retourne les données paginées', async () => {
      repository.listTeachers.mockResolvedValue({ rows: [baseTeacher], total: 1 });

      const result = await service.listTeachers({ page: 1, limit: 10 });

      expect(result.data).toHaveLength(1);
      expect(result.pagination.total).toBe(1);
      expect(result.pagination.totalPages).toBe(1);
    });

    it('calcule correctement totalPages', async () => {
      repository.listTeachers.mockResolvedValue({ rows: [], total: 25 });

      const result = await service.listTeachers({ page: 1, limit: 10 });

      expect(result.pagination.totalPages).toBe(3);
    });

    it('retourne totalPages=1 si pas de résultat', async () => {
      repository.listTeachers.mockResolvedValue({ rows: [], total: 0 });

      const result = await service.listTeachers({ page: 1, limit: 10 });

      expect(result.pagination.totalPages).toBe(1);
    });
  });

  // ── getTeacherById ────────────────────────────────────────────────────────

  describe('getTeacherById', () => {
    it('retourne le DTO si le prof existe', async () => {
      repository.getTeacherById.mockResolvedValue(baseTeacher);

      const result = await service.getTeacherById('teacher-1');

      expect(result.id).toBe('teacher-1');
      expect(result.type).toBe('vacataire');
    });

    it('leve TEACHER_NOT_FOUND si absent', async () => {
      repository.getTeacherById.mockResolvedValue(null);

      await expect(service.getTeacherById('missing')).rejects.toMatchObject({
        code: 'TEACHER_NOT_FOUND',
        statusCode: 404,
      });
    });
  });


  // ── updateTeacher ─────────────────────────────────────────────────────────

  describe('updateTeacher', () => {
    it('bloque le changement de type si des salaires ne sont pas payés', async () => {
      repository.getTeacherById.mockResolvedValue(baseTeacher);
      repository.hasOutstandingUnpaidSalaryRecords.mockResolvedValue(true);

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

    it('rejette si hourly_rate manquant pour vacataire', async () => {
      repository.getTeacherById.mockResolvedValue({ ...baseTeacher, hourly_rate: null });

      await expect(
        service.updateTeacher(baseTeacher.id, { hourly_rate: null })
      ).rejects.toMatchObject({ code: 'HOURLY_RATE_REQUIRED', statusCode: 400 });
    });

    it('rejette si monthly_salary manquant pour permanent', async () => {
      repository.getTeacherById.mockResolvedValue({ ...basePermanent, monthly_salary: null });

      await expect(
        service.updateTeacher(basePermanent.id, { monthly_salary: null })
      ).rejects.toMatchObject({ code: 'MONTHLY_SALARY_REQUIRED', statusCode: 400 });
    });

    it('leve TEACHER_NOT_FOUND si le prof est absent à la mise à jour', async () => {
      repository.getTeacherById.mockResolvedValue(null);

      await expect(
        service.updateTeacher('missing', { phone: '0102030405' })
      ).rejects.toMatchObject({ code: 'TEACHER_NOT_FOUND', statusCode: 404 });
    });

    it('annule hourly_rate quand le type passe à permanent', async () => {
      repository.getTeacherById.mockResolvedValue(baseTeacher);
      repository.hasOutstandingUnpaidSalaryRecords.mockResolvedValue(false);
      repository.updateTeacher.mockResolvedValue({
        ...baseTeacher,
        type: 'permanent',
        hourly_rate: null,
        monthly_salary: 350000,
      });

      await service.updateTeacher(baseTeacher.id, {
        type: 'permanent',
        monthly_salary: 350000,
      });

      expect(repository.updateTeacher).toHaveBeenCalledWith(
        baseTeacher.id,
        expect.objectContaining({ hourly_rate: null, monthly_salary: 350000 })
      );
    });

    it('annule monthly_salary quand le type passe à vacataire', async () => {
      repository.getTeacherById.mockResolvedValue(basePermanent);
      repository.hasOutstandingUnpaidSalaryRecords.mockResolvedValue(false);
      repository.updateTeacher.mockResolvedValue({
        ...basePermanent,
        type: 'vacataire',
        hourly_rate: 6000,
        monthly_salary: null,
      });

      await service.updateTeacher(basePermanent.id, {
        type: 'vacataire',
        hourly_rate: 6000,
      });

      expect(repository.updateTeacher).toHaveBeenCalledWith(
        basePermanent.id,
        expect.objectContaining({ monthly_salary: null, hourly_rate: 6000 })
      );
    });
  });

  // ── softDeleteTeacher ─────────────────────────────────────────────────────

  describe('softDeleteTeacher', () => {
    it('retourne le DTO avec is_active=false', async () => {
      const deletedTeacher = { ...baseTeacher, is_active: false };
      repository.softDeleteTeacher.mockResolvedValue(deletedTeacher);

      const result = await service.softDeleteTeacher(baseTeacher.id);

      expect(result.is_active).toBe(false);
    });

    it('leve TEACHER_NOT_FOUND si absent', async () => {
      repository.softDeleteTeacher.mockResolvedValue(null);

      await expect(service.softDeleteTeacher('missing')).rejects.toMatchObject({
        code: 'TEACHER_NOT_FOUND',
        statusCode: 404,
      });
    });
  });

  // ── getTeacherStats ───────────────────────────────────────────────────────

  describe('getTeacherStats', () => {
    it('retourne les stats de présence et montant dû', async () => {
      repository.getTeacherStats.mockResolvedValue({
        attendance_rate: 85,
        hours_worked: 40,
        amount_due: 200000,
      });

      const result = await service.getTeacherStats('teacher-1', '2026-04-01', '2026-04-30');

      expect(result.attendance_rate).toBe(85);
      expect(result.hours_worked).toBe(40);
      expect(result.amount_due).toBe(200000);
    });

    it('leve TEACHER_NOT_FOUND si stats absentes', async () => {
      repository.getTeacherStats.mockResolvedValue(null);

      await expect(service.getTeacherStats('missing', '2026-04-01', '2026-04-30')).rejects.toMatchObject({
        code: 'TEACHER_NOT_FOUND',
        statusCode: 404,
      });
    });
  });
});
