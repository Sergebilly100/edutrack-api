import type { CreateTeacherInput, TeachersListQuery, UpdateTeacherInput } from './teachers.types.js';
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

export class TeachersService {
  constructor(private readonly repository: TeachersRepository) {}

  async listTeachers(query: TeachersListQuery): Promise<
    | {
        data: Array<{
          id: string;
          name: string;
          first_name: string;
          last_name: string;
          phone: string | null;
          type: 'vacataire' | 'permanent';
          subjects: string[];
          hourly_rate: number | null;
          is_active: boolean;
          username: string;
        }>;
        pagination: {
          page: number;
          limit: number;
          total: number;
          totalPages: number;
        };
      }
    | Array<{
        id: string;
        name: string;
        first_name: string;
        last_name: string;
        phone: string | null;
        type: 'vacataire' | 'permanent';
        subjects: string[];
        hourly_rate: number | null;
        is_active: boolean;
        username: string;
      }>
  > {
    const result = await this.repository.listTeachers(query);
    const rows = result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      first_name: row.first_name,
      last_name: row.last_name,
      phone: row.phone,
      type: row.type,
      subjects: row.subjects,
      hourly_rate: row.hourly_rate,
      is_active: row.is_active,
      username: row.username,
    }));

    return {
      data: rows,
      pagination: {
        page: query.page,
        limit: query.limit,
        total: result.total,
        totalPages: Math.ceil(result.total / query.limit) || 1,
      },
    };
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
    return {
      id: created.id,
      name: created.name,
      first_name: created.first_name,
      last_name: created.last_name,
      phone: created.phone,
      type: created.type,
      subjects: created.subjects,
      hourly_rate: created.hourly_rate,
      is_active: created.is_active,
      username: created.username,
    };
  }

  async updateTeacher(teacherId: string, input: UpdateTeacherInput) {
    const updated = await this.repository.updateTeacher(teacherId, input);
    if (!updated) {
      throw new TeachersModuleError('Teacher not found', 404, 'TEACHER_NOT_FOUND');
    }

    return {
      id: updated.id,
      name: updated.name,
      first_name: updated.first_name,
      last_name: updated.last_name,
      phone: updated.phone,
      type: updated.type,
      subjects: updated.subjects,
      hourly_rate: updated.hourly_rate,
      is_active: updated.is_active,
      username: updated.username,
    };
  }

  async softDeleteTeacher(teacherId: string) {
    const deleted = await this.repository.softDeleteTeacher(teacherId);
    if (!deleted) {
      throw new TeachersModuleError('Teacher not found', 404, 'TEACHER_NOT_FOUND');
    }

    return {
      id: deleted.id,
      name: deleted.name,
      first_name: deleted.first_name,
      last_name: deleted.last_name,
      phone: deleted.phone,
      type: deleted.type,
      subjects: deleted.subjects,
      hourly_rate: deleted.hourly_rate,
      is_active: deleted.is_active,
      username: deleted.username,
    };
  }

  async getTeacherStats(teacherId: string, dateFrom: string, dateTo: string) {
    const stats = await this.repository.getTeacherStats(teacherId, dateFrom, dateTo);
    if (!stats) {
      throw new TeachersModuleError('Teacher not found', 404, 'TEACHER_NOT_FOUND');
    }

    return stats;
  }
}

export const buildTeachersService = (
  db: ConstructorParameters<typeof TeachersRepository>[0]
): TeachersService => new TeachersService(new TeachersRepository(db));
