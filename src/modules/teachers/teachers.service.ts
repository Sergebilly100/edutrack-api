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

    const created = await this.repository.createTeacher(input);
    return toDTO(created);
  }

  async updateTeacher(teacherId: string, input: UpdateTeacherInput) {
    const updated = await this.repository.updateTeacher(teacherId, input);
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
