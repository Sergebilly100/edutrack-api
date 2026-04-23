import type {
  CreateTeacherInput,
  TeacherAttendanceStatsQuery,
  TeachersListQuery,
  UpdateTeacherInput,
} from './teachers.types.js';
import { TeachersRepository } from './teachers.repository.js';
import {
  buildUsersLimitReachedMessage,
  getMaxUsersBySchemaName,
} from '../../shared/utils/users-limit.js';
import { canonicalizeSubjectList } from '../../shared/utils/subject-normalization.js';

export class TeachersModuleError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message);
    this.name = 'TeachersModuleError';
  }
}

// DTO partagé pour toutes les réponses du module teachers.
// Expose les deux dimensions distinctes :
//   • is_active    → accès au compte (table users)
//   • is_blocked   → blocage métier avec motif (table teachers)
type TeacherDTO = {
  id: string;
  name: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  type: 'vacataire' | 'permanent';
  subjects: string[];
  hourly_rate: number | null;
  monthly_salary: number | null;
  is_active: boolean;
  is_blocked: boolean;
  blocked_reason: string | null;
  blocked_at: Date | null;
  username: string;
};

const toDTO = (row: {
  id: string;
  name: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  type: 'vacataire' | 'permanent';
  subjects: string[];
  hourly_rate: number | null;
  monthly_salary: number | null;
  is_active: boolean;
  is_blocked: boolean;
  blocked_reason: string | null;
  blocked_at: Date | null;
  username: string;
}): TeacherDTO => ({
  id: row.id,
  name: row.name,
  first_name: row.first_name,
  last_name: row.last_name,
  phone: row.phone,
  type: row.type,
  subjects: row.subjects,
  hourly_rate: row.hourly_rate,
  monthly_salary: row.monthly_salary,
  is_active: row.is_active,
  is_blocked: row.is_blocked,
  blocked_reason: row.blocked_reason,
  blocked_at: row.blocked_at,
  username: row.username,
});

export class TeachersService {
  constructor(private readonly repository: TeachersRepository) {}

  async listTeachers(query: TeachersListQuery): Promise<{
    data: TeacherDTO[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const result = await this.repository.listTeachers(query);
    return {
      data: result.rows.map(toDTO),
      pagination: {
        page: query.page,
        limit: query.limit,
        total: result.total,
        totalPages: Math.ceil(result.total / query.limit) || 1,
      },
    };
  }

  async getTeacherById(teacherId: string): Promise<TeacherDTO> {
    const row = await this.repository.getTeacherById(teacherId);
    if (!row) {
      throw new TeachersModuleError('Teacher not found', 404, 'TEACHER_NOT_FOUND');
    }
    return toDTO(row);
  }

  async createTeacher(input: CreateTeacherInput, context: { schemaName: string }) {
    const [currentCount, maxUsers] = await Promise.all([
      this.repository.countActiveUsers(),
      getMaxUsersBySchemaName(context.schemaName),
    ]);

    if (currentCount >= maxUsers) {
      throw new TeachersModuleError(
        buildUsersLimitReachedMessage(currentCount, maxUsers),
        403,
        'USERS_LIMIT_REACHED'
      );
    }

    const created = await this.repository.createTeacher({
      ...input,
      subjects: canonicalizeSubjectList(input.subjects),
    });
    return toDTO(created);
  }

  async updateTeacher(teacherId: string, input: UpdateTeacherInput) {
    const current = await this.repository.getTeacherById(teacherId);
    if (!current) {
      throw new TeachersModuleError('Teacher not found', 404, 'TEACHER_NOT_FOUND');
    }

    const nextType = input.type ?? current.type;
    const nextHourlyRate =
      input.hourly_rate !== undefined ? input.hourly_rate : current.hourly_rate;
    const nextMonthlySalary =
      input.monthly_salary !== undefined ? input.monthly_salary : current.monthly_salary;

    if (nextType === 'vacataire' && nextHourlyRate === null) {
      throw new TeachersModuleError(
        'Hourly rate is required for vacataire',
        400,
        'HOURLY_RATE_REQUIRED'
      );
    }

    if (nextType === 'permanent' && nextMonthlySalary === null) {
      throw new TeachersModuleError(
        'Monthly salary is required for permanent',
        400,
        'MONTHLY_SALARY_REQUIRED'
      );
    }

    if (input.type !== undefined && input.type !== current.type) {
      const hasOutstandingUnpaidSalaryRecords =
        await this.repository.hasOutstandingUnpaidSalaryRecords(teacherId);
      if (hasOutstandingUnpaidSalaryRecords) {
        throw new TeachersModuleError(
          'Teacher type change is blocked until all salary records are paid',
          409,
          'TEACHER_TYPE_CHANGE_BLOCKED'
        );
      }
    }

    const updated = await this.repository.updateTeacher(teacherId, {
      ...input,
      ...(input.subjects ? { subjects: canonicalizeSubjectList(input.subjects) } : {}),
      hourly_rate: nextType === 'permanent' ? null : nextHourlyRate,
      monthly_salary: nextType === 'vacataire' ? null : nextMonthlySalary,
    });
    if (!updated) {
      throw new TeachersModuleError('Teacher not found', 404, 'TEACHER_NOT_FOUND');
    }
    return toDTO(updated);
  }

  async softDeleteTeacher(teacherId: string) {
    const deleted = await this.repository.softDeleteTeacher(teacherId);
    if (!deleted) {
      throw new TeachersModuleError('Teacher not found', 404, 'TEACHER_NOT_FOUND');
    }
    return toDTO(deleted);
  }

  async getTeacherStats(teacherId: string, dateFrom: string, dateTo: string) {
    const stats = await this.repository.getTeacherStats(teacherId, dateFrom, dateTo);
    if (!stats) {
      throw new TeachersModuleError('Teacher not found', 404, 'TEACHER_NOT_FOUND');
    }
    return stats;
  }

  async getAttendanceStats(params: TeacherAttendanceStatsQuery) {
    return this.repository.getAttendanceStats(params);
  }
}

export const buildTeachersService = (
  db: ConstructorParameters<typeof TeachersRepository>[0]
): TeachersService => new TeachersService(new TeachersRepository(db));
