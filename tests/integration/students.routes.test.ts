import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withTenantSchema: vi.fn(),
  verifyAccessToken: vi.fn(),
  buildStudentsService: vi.fn(),
  service: {
    listStudents: vi.fn(),
    createStudent: vi.fn(),
    getStudentDetail: vi.fn(),
    updateStudent: vi.fn(),
    softDeleteStudent: vi.fn(),
    bulkMarkAbsences: vi.fn(),
    listAttendanceHistory: vi.fn(),
    listTodayAbsences: vi.fn(),
    getAbsenceStats: vi.fn(),
    getStudentAbsences: vi.fn(),
  },
}));

vi.mock('../../src/shared/database/db.js', () => ({
  withTenantSchema: mocks.withTenantSchema,
}));

vi.mock('../../src/modules/auth/auth.service.js', async () => {
  const actual = await vi.importActual('../../src/modules/auth/auth.service.js');
  return {
    ...actual,
    verifyAccessToken: mocks.verifyAccessToken,
  };
});

vi.mock('../../src/modules/students/students.service.js', () => ({
  StudentsModuleError: class extends Error {
    statusCode: number;
    code: string;

    constructor(message: string, statusCode: number, code: string) {
      super(message);
      this.statusCode = statusCode;
      this.code = code;
    }
  },
  buildStudentsService: mocks.buildStudentsService,
}));

import studentsController from '../../src/modules/students/students.controller.js';

const buildApp = async () => {
  const app = Fastify();
  await app.register(studentsController);
  await app.ready();
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();

  mocks.withTenantSchema.mockImplementation(async (_schema, callback) => {
    return callback({ execute: vi.fn() });
  });

  mocks.verifyAccessToken.mockResolvedValue({
    sub: 'user-1',
    role: 'director',
    schemaName: 'school_sainte_marie',
  });

  mocks.buildStudentsService.mockReturnValue(mocks.service);

  mocks.service.listStudents.mockResolvedValue({
    data: [
      {
        id: 'student-1',
        classId: 'class-1',
        className: '3eme A',
        firstName: 'Awa',
        lastName: 'Kouassi',
        parentPhone: '2250700000011',
        parentPhone2: null,
        isActive: true,
        createdAt: '2026-04-13T10:00:00.000Z',
      },
    ],
    pagination: {
      page: 2,
      limit: 1,
      total: 3,
      totalPages: 3,
    },
  });

  mocks.service.bulkMarkAbsences.mockResolvedValue({
    createdAttendances: 3,
    emittedEvents: 3,
  });

  mocks.service.listAttendanceHistory.mockResolvedValue({
    data: [],
    pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
  });

  mocks.service.listTodayAbsences.mockResolvedValue([]);
  mocks.service.getAbsenceStats.mockResolvedValue([]);
  mocks.service.getStudentAbsences.mockResolvedValue([]);
  mocks.service.getStudentDetail.mockResolvedValue({
    id: 'student-1',
    firstName: 'Awa',
    lastName: 'Kouassi',
    className: '3eme A',
    classId: 'class-1',
    isActive: true,
    parentPhone: '2250700000011',
    parentPhone2: null,
    parentName: 'Maman Awa',
    parentName2: null,
    note: null,
    createdAt: '2026-04-13T10:00:00.000Z',
    absenceSummary: {
      total: 2,
      thisMonth: 1,
      thisWeek: 1,
    },
    recentAbsences: [],
    documents: [],
    parentSms: [],
  });
});

describe('students routes', () => {
  it('GET /api/v1/students retourne 401 sans header Authorization', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/students',
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('GET /api/v1/students retourne les données paginées', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/students?page=2&limit=1&search=awa',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      data: Array<{ id: string }>;
      pagination: { page: number; limit: number; total: number; totalPages: number };
    };

    expect(body.pagination).toEqual({
      page: 2,
      limit: 1,
      total: 3,
      totalPages: 3,
    });
    expect(body.data[0]?.id).toBe('student-1');
    expect(mocks.service.listStudents).toHaveBeenCalledWith({
      page: 2,
      limit: 1,
      class_id: undefined,
      is_active: undefined,
      search: 'awa',
    });

    await app.close();
  });

  it('POST /api/v1/attendance/students/bulk appelle le service bulk', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/attendance/students/bulk',
      headers: { authorization: 'Bearer valid-token' },
      payload: {
        scheduleId: 'd81cecfb-6544-4651-a420-84e7ca2419c7',
        date: '2026-04-13',
        absences: [
          '66f048d8-d053-48e2-b4a8-7fce3ebc3ed8',
          '50049931-f1cd-4e3b-8f7f-a20567e85e77',
          'f2138a28-b5de-4689-a702-d00abeb74aa0',
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.service.bulkMarkAbsences).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('GET /api/v1/students/:id retourne le détail élève', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/students/66f048d8-d053-48e2-b4a8-7fce3ebc3ed8',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.service.getStudentDetail).toHaveBeenCalledWith(
      '66f048d8-d053-48e2-b4a8-7fce3ebc3ed8'
    );

    await app.close();
  });

  it('GET /api/v1/students/absence-stats appelle le service stats (route statique prioritaire)', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/students/absence-stats?from=2026-04-01&to=2026-04-21&min_absences=2',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.service.getAbsenceStats).toHaveBeenCalledWith({
      from: '2026-04-01',
      to: '2026-04-21',
      class_id: undefined,
      subject: undefined,
      sms_status: undefined,
      min_absences: 2,
    });
    expect(mocks.service.getStudentDetail).not.toHaveBeenCalledWith('absence-stats');

    await app.close();
  });

  it('GET /api/v1/students/:studentId/absences appelle le service détail absences', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/students/66f048d8-d053-48e2-b4a8-7fce3ebc3ed8/absences?from=2026-04-01&to=2026-04-21&subject=Math',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.service.getStudentAbsences).toHaveBeenCalledWith(
      '66f048d8-d053-48e2-b4a8-7fce3ebc3ed8',
      { from: '2026-04-01', to: '2026-04-21', subject: 'Math' }
    );

    await app.close();
  });

  it('POST /api/v1/students retourne 400 avec parent_phone invalide', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/students',
      headers: { authorization: 'Bearer valid-token' },
      payload: {
        class_id: 'd81cecfb-6544-4651-a420-84e7ca2419c7',
        first_name: 'Awa',
        last_name: 'Kouassi',
        parent_phone: '0700000001',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as { code: string };
    expect(body.code).toBe('BAD_REQUEST');

    await app.close();
  });

  it('GET /api/v1/attendance/students transmet schedule_id au service', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/attendance/students?schedule_id=d81cecfb-6544-4651-a420-84e7ca2419c7&student_id=66f048d8-d053-48e2-b4a8-7fce3ebc3ed8&page=1&limit=20',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.service.listAttendanceHistory).toHaveBeenCalledWith({
      page: 1,
      limit: 20,
      class_id: undefined,
      student_id: '66f048d8-d053-48e2-b4a8-7fce3ebc3ed8',
      schedule_id: 'd81cecfb-6544-4651-a420-84e7ca2419c7',
      date_from: undefined,
      date_to: undefined,
    });

    await app.close();
  });

  it('GET /api/v1/students refuse un rôle non autorisé', async () => {
    mocks.verifyAccessToken.mockResolvedValue({
      sub: 'user-2',
      role: 'super_admin',
      schemaName: 'school_sainte_marie',
    });

    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/students',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(response.statusCode).toBe(403);

    await app.close();
  });
});
