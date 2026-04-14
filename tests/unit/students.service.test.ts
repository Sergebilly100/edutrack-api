import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StudentsService } from '../../src/modules/students/students.service.js';

const repository = {
  listStudents: vi.fn(),
  createStudent: vi.fn(),
  updateStudent: vi.fn(),
  softDeleteStudent: vi.fn(),
  findScheduleById: vi.fn(),
  findStudentsForAbsence: vi.fn(),
  upsertStudentAbsences: vi.fn(),
  getTenantIdBySchemaName: vi.fn(),
  getSchoolPhone: vi.fn(),
  listAttendanceHistory: vi.fn(),
  listTodayAbsences: vi.fn(),
};

const eventEmitter = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('students.service', () => {
  it('listStudents() retourne une pagination correcte', async () => {
    repository.listStudents.mockResolvedValue({
      rows: [
        {
          id: 'student-1',
          classId: 'class-1',
          className: '6e A',
          firstName: 'Awa',
          lastName: 'Kouassi',
          parentPhone: '2250700000001',
          parentPhone2: null,
          isActive: true,
          createdAt: '2026-04-13T10:00:00.000Z',
        },
      ],
      total: 45,
    });

    const service = new StudentsService(repository as never, {
      eventEmitter,
    });

    const result = await service.listStudents({
      page: 2,
      limit: 20,
      class_id: undefined,
      is_active: undefined,
      search: undefined,
    });

    expect(result.pagination).toEqual({
      page: 2,
      limit: 20,
      total: 45,
      totalPages: 3,
    });
    expect(result.data).toHaveLength(1);
  });

  it('bulkMarkAbsences() crée les attendances et émet seulement pour les parents avec phone', async () => {
    repository.findScheduleById.mockResolvedValue({
      id: 'schedule-1',
      classId: 'class-1',
      subject: 'Maths',
    });
    repository.findStudentsForAbsence.mockResolvedValue([
      {
        id: 'student-1',
        firstName: 'Awa',
        parentPhone: '2250700000001',
      },
      {
        id: 'student-2',
        firstName: 'Yao',
        parentPhone: null,
      },
      {
        id: 'student-3',
        firstName: 'Mariam',
        parentPhone: '2250700000003',
      },
    ]);
    repository.upsertStudentAbsences.mockResolvedValue(3);
    repository.getTenantIdBySchemaName.mockResolvedValue('tenant-1');
    repository.getSchoolPhone.mockResolvedValue('2250701234567');

    const service = new StudentsService(repository as never, {
      eventEmitter,
    });

    const result = await service.bulkMarkAbsences(
      {
        scheduleId: 'schedule-1',
        date: '2026-04-13',
        absences: ['student-1', 'student-2', 'student-3'],
      },
      {
        userId: 'user-1',
        schemaName: 'school_sainte_marie',
      }
    );

    expect(result).toEqual({
      createdAttendances: 3,
      emittedEvents: 2,
    });
    expect(repository.upsertStudentAbsences).toHaveBeenCalledWith({
      scheduleId: 'schedule-1',
      date: '2026-04-13',
      studentIds: ['student-1', 'student-2', 'student-3'],
      markedBy: 'user-1',
    });
    expect(eventEmitter).toHaveBeenCalledTimes(2);
    expect(eventEmitter).toHaveBeenNthCalledWith(
      1,
      'student.absent',
      expect.objectContaining({
        tenantId: 'tenant-1',
        scheduleId: 'schedule-1',
        studentId: 'student-1',
        parentPhone: '2250700000001',
      })
    );
  });

  it('softDeleteStudent() lève STUDENT_NOT_FOUND si l\'élève est déjà inactif', async () => {
    repository.softDeleteStudent.mockResolvedValue(null);

    const service = new StudentsService(repository as never, { eventEmitter });

    await expect(service.softDeleteStudent('student-inactive')).rejects.toMatchObject({
      code: 'STUDENT_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('bulkMarkAbsences() lève INVALID_ABSENCE_STUDENT_IDS si un ID est hors classe', async () => {
    repository.findScheduleById.mockResolvedValue({
      id: 'schedule-1',
      classId: 'class-1',
      subject: 'Maths',
    });
    repository.findStudentsForAbsence.mockResolvedValue([
      { id: 'student-1', firstName: 'Awa', parentPhone: '2250700000001' },
      { id: 'student-2', firstName: 'Yao', parentPhone: null },
    ]);

    const service = new StudentsService(repository as never, { eventEmitter });

    await expect(
      service.bulkMarkAbsences(
        {
          scheduleId: 'schedule-1',
          date: '2026-04-13',
          absences: ['student-1', 'student-2', 'student-unknown'],
        },
        { userId: 'user-1', schemaName: 'school_sainte_marie' }
      )
    ).rejects.toMatchObject({
      code: 'INVALID_ABSENCE_STUDENT_IDS',
      statusCode: 400,
    });
  });

  it('bulkMarkAbsences() lève SCHEDULE_NOT_FOUND si le schedule n\'existe pas', async () => {
    repository.findScheduleById.mockResolvedValue(null);

    const service = new StudentsService(repository as never, { eventEmitter });

    await expect(
      service.bulkMarkAbsences(
        { scheduleId: 'schedule-inexistant', date: '2026-04-13', absences: ['student-1'] },
        { userId: 'user-1', schemaName: 'school_sainte_marie' }
      )
    ).rejects.toMatchObject({
      code: 'SCHEDULE_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('listTodayAbsences() regroupe correctement plusieurs absences de la même classe', async () => {
    repository.listTodayAbsences.mockResolvedValue([
      {
        classId: 'class-1',
        className: '3eme A',
        studentId: 'student-1',
        studentFirstName: 'Awa',
        studentLastName: 'Kouassi',
        scheduleId: 'sched-1',
        date: '2026-04-13',
        smsStatus: 'sent',
        smsNotified: true,
      },
      {
        classId: 'class-1',
        className: '3eme A',
        studentId: 'student-2',
        studentFirstName: 'Yao',
        studentLastName: 'Bamba',
        scheduleId: 'sched-1',
        date: '2026-04-13',
        smsStatus: null,
        smsNotified: false,
      },
      {
        classId: 'class-2',
        className: '3eme B',
        studentId: 'student-3',
        studentFirstName: 'Mariam',
        studentLastName: 'Traore',
        scheduleId: 'sched-2',
        date: '2026-04-13',
        smsStatus: 'queued',
        smsNotified: false,
      },
    ]);

    const service = new StudentsService(repository as never, { eventEmitter });
    const result = await service.listTodayAbsences('2026-04-13');

    expect(result).toHaveLength(2);
    const classeA = result.find((g) => g.classId === 'class-1');
    expect(classeA?.absences).toHaveLength(2);
    const classeB = result.find((g) => g.classId === 'class-2');
    expect(classeB?.absences).toHaveLength(1);
  });
});
