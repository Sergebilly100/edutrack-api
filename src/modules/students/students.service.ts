import { db as defaultGlobalDb } from '../../shared/database/db.js';
import { emit } from '../../shared/events/event-bus.js';
import type { StudentAbsentPayload } from '../../shared/events/events.types.js';

import { StudentsRepository } from './students.repository.js';
import type {
  AttendanceStudentRecord,
  AttendanceHistoryQuery,
  BulkAttendanceInput,
  CreateStudentInput,
  PaginationMeta,
  StudentRecord,
  StudentsListQuery,
  TodayAbsenceGroup,
  UpdateStudentInput,
} from './students.types.js';

export class StudentsModuleError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message);
    this.name = 'StudentsModuleError';
  }
}

type EventEmitter = (event: 'student.absent', payload: StudentAbsentPayload) => Promise<void> | void;

type ServiceDependencies = {
  eventEmitter: EventEmitter;
  defaultSchoolPhone: string;
};

const DEFAULT_DEPENDENCIES: ServiceDependencies = {
  eventEmitter: emit,
  defaultSchoolPhone: process.env.DEFAULT_SCHOOL_PHONE ?? '2250000000000',
};

const toPaginationMeta = (page: number, limit: number, total: number): PaginationMeta => ({
  page,
  limit,
  total,
  totalPages: total === 0 ? 0 : Math.ceil(total / limit),
});

const isDbConstraintError = (error: unknown, code: string): boolean => {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }

  return (error as { code?: string }).code === code;
};

const deduplicateAbsences = (ids: string[]): string[] => Array.from(new Set(ids));

export class StudentsService {
  private readonly deps: ServiceDependencies;

  constructor(
    private readonly repository: StudentsRepository,
    deps: Partial<ServiceDependencies> = {}
  ) {
    this.deps = { ...DEFAULT_DEPENDENCIES, ...deps };
  }

  async listStudents(query: StudentsListQuery): Promise<{
    data: StudentRecord[];
    pagination: PaginationMeta;
  }> {
    const { rows, total } = await this.repository.listStudents(query);

    return {
      data: rows,
      pagination: toPaginationMeta(query.page, query.limit, total),
    };
  }

  async createStudent(input: CreateStudentInput): Promise<StudentRecord> {
    try {
      return await this.repository.createStudent(input);
    } catch (error) {
      if (error instanceof Error && error.message === 'Class not found') {
        throw new StudentsModuleError('Class not found', 404, 'CLASS_NOT_FOUND');
      }

      if (isDbConstraintError(error, '23503')) {
        throw new StudentsModuleError('Class not found', 404, 'CLASS_NOT_FOUND');
      }

      throw error;
    }
  }

  async updateStudent(studentId: string, input: UpdateStudentInput): Promise<StudentRecord> {
    try {
      const student = await this.repository.updateStudent(studentId, input);
      if (!student) {
        throw new StudentsModuleError('Student not found', 404, 'STUDENT_NOT_FOUND');
      }

      return student;
    } catch (error) {
      if (error instanceof StudentsModuleError) {
        throw error;
      }

      if (isDbConstraintError(error, '23503')) {
        throw new StudentsModuleError('Class not found', 404, 'CLASS_NOT_FOUND');
      }

      throw error;
    }
  }

  async softDeleteStudent(studentId: string): Promise<StudentRecord> {
    const student = await this.repository.softDeleteStudent(studentId);
    if (!student) {
      throw new StudentsModuleError('Student not found', 404, 'STUDENT_NOT_FOUND');
    }

    return student;
  }

  async bulkMarkAbsences(
    input: BulkAttendanceInput,
    context: {
      userId: string;
      schemaName: string;
    }
  ): Promise<{
    createdAttendances: number;
    emittedEvents: number;
  }> {
    const schedule = await this.repository.findScheduleById(input.scheduleId);
    if (!schedule) {
      throw new StudentsModuleError('Schedule not found', 404, 'SCHEDULE_NOT_FOUND');
    }

    const distinctAbsences = deduplicateAbsences(input.absences);
    if (distinctAbsences.length === 0) {
      return {
        createdAttendances: 0,
        emittedEvents: 0,
      };
    }

    const absentStudents = await this.repository.findStudentsForAbsence(
      schedule.classId,
      distinctAbsences
    );

    if (absentStudents.length !== distinctAbsences.length) {
      throw new StudentsModuleError(
        'One or more student IDs are invalid for the schedule class',
        400,
        'INVALID_ABSENCE_STUDENT_IDS'
      );
    }

    const createdAttendances = await this.repository.upsertStudentAbsences({
      scheduleId: input.scheduleId,
      date: input.date,
      studentIds: distinctAbsences,
      markedBy: context.userId,
    });

    const tenantId = await this.repository.getTenantIdBySchemaName(context.schemaName);
    if (!tenantId) {
      throw new StudentsModuleError('Tenant not found', 404, 'TENANT_NOT_FOUND');
    }

    const schoolPhone =
      (await this.repository.getSchoolPhone()) ?? this.deps.defaultSchoolPhone;

    let emittedEvents = 0;
    for (const student of absentStudents) {
      if (!student.parentPhone) {
        continue;
      }

      await this.deps.eventEmitter('student.absent', {
        tenantId,
        schemaName: context.schemaName,
        studentId: student.id,
        studentFirstName: student.firstName,
        parentPhone: student.parentPhone,
        subject: schedule.subject,
        date: input.date,
        schoolPhone,
      });
      emittedEvents += 1;
    }

    return {
      createdAttendances,
      emittedEvents,
    };
  }

  async listAttendanceHistory(query: AttendanceHistoryQuery): Promise<{
    data: AttendanceStudentRecord[];
    pagination: PaginationMeta;
  }> {
    const { rows, total } = await this.repository.listAttendanceHistory(query);

    return {
      data: rows,
      pagination: toPaginationMeta(query.page, query.limit, total),
    };
  }

  async listTodayAbsences(date?: string): Promise<TodayAbsenceGroup[]> {
    const rows = await this.repository.listTodayAbsences(date);

    const grouped = new Map<string, TodayAbsenceGroup>();
    for (const row of rows) {
      const key = `${row.classId}:${row.className}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.absences.push({
          studentId: row.studentId,
          studentFirstName: row.studentFirstName,
          studentLastName: row.studentLastName,
          scheduleId: row.scheduleId,
          date: row.date,
        });
        continue;
      }

      grouped.set(key, {
        classId: row.classId,
        className: row.className,
        absences: [
          {
            studentId: row.studentId,
            studentFirstName: row.studentFirstName,
            studentLastName: row.studentLastName,
            scheduleId: row.scheduleId,
            date: row.date,
          },
        ],
      });
    }

    return Array.from(grouped.values());
  }
}

export const buildStudentsService = (
  tenantDb: ConstructorParameters<typeof StudentsRepository>[0],
  globalDb: ConstructorParameters<typeof StudentsRepository>[1] = defaultGlobalDb
) => new StudentsService(new StudentsRepository(tenantDb, globalDb));
