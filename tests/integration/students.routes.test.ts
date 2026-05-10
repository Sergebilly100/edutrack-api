import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withTenantSchema: vi.fn(),
  requirePermission: vi.fn(),
  requireTeacherOrDirectorOrSecretary: vi.fn(),
  buildStudentsService: vi.fn(),
  service: {
    listStudents: vi.fn(),
    teacherCanAccessClass: vi.fn(),
    createStudent: vi.fn(),
    getStudentDetail: vi.fn(),
    updateStudent: vi.fn(),
    softDeleteStudent: vi.fn(),
    bulkMarkAbsences: vi.fn(),
    listAttendanceHistory: vi.fn(),
    listTodayAbsences: vi.fn(),
    getAbsenceStats: vi.fn(),
    getStudentAbsences: vi.fn(),
    excuseAbsence: vi.fn(),
  },
}));

vi.mock('../../src/shared/database/db.js', () => ({
  withTenantSchema: mocks.withTenantSchema,
}));

vi.mock('../../src/shared/middleware/auth.middleware.js', () => ({
  requirePermission: mocks.requirePermission,
  requireTeacherOrDirectorOrSecretary: mocks.requireTeacherOrDirectorOrSecretary,
}));

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

// ─── Auth/Permission middleware helpers ───────────────────────────────────────

const attachClaims = (
  request: { headers: Record<string, unknown>; claims?: unknown; permissions?: Set<string> },
  reply: { code: (n: number) => { send: (p: unknown) => void } }
): boolean => {
  if (!request.headers.authorization) {
    reply.code(401).send({ error: 'Missing Authorization header', code: 'UNAUTHORIZED', statusCode: 401 });
    return false;
  }
  const role = (() => {
    const r = request.headers['x-test-role'];
    return typeof r === 'string' && r.length > 0 ? r : 'director';
  })();
  if (!['teacher', 'director', 'staff'].includes(role)) {
    reply.code(403).send({ error: 'Forbidden', code: 'FORBIDDEN', statusCode: 403 });
    return false;
  }
  request.claims = { sub: 'user-1', role, schemaName: 'school_test' };
  return true;
};

beforeEach(() => {
  vi.clearAllMocks();

  mocks.withTenantSchema.mockImplementation(async (_schema: string, cb: unknown) => {
    return (cb as (db: unknown) => unknown)({ execute: vi.fn() });
  });

  mocks.requirePermission.mockImplementation((permission: string) => {
    return async (request: never, reply: never) => {
      if (!attachClaims(request, reply)) return;
      const rawPermissions = (request as Record<string, unknown>)['headers'] as Record<string, unknown>;
      const header = rawPermissions['x-test-permissions'];
      const permissions =
        typeof header === 'string' && header.trim().length > 0
          ? header.split(',').map((v) => v.trim())
          : [permission];
      (request as Record<string, unknown>)['permissions'] = new Set(permissions);
      if (!permissions.includes(permission)) {
        (reply as { code: (n: number) => { send: (p: unknown) => void } })
          .code(403)
          .send({ error: `Permission ${permission} required`, code: 'FORBIDDEN', statusCode: 403 });
      }
    };
  });

  mocks.requireTeacherOrDirectorOrSecretary.mockImplementation(async (request: never, reply: never) => {
    if (!attachClaims(request, reply)) return;
    const rawPermissions = (request as Record<string, unknown>)['headers'] as Record<string, unknown>;
    const header = rawPermissions['x-test-permissions'];
    const permissions =
      typeof header === 'string' && header.trim().length > 0
        ? header.split(',').map((v) => v.trim())
        : ['students.view', 'attendance.view', 'attendance.mark_students'];
    (request as Record<string, unknown>)['permissions'] = new Set(permissions);
  });

  mocks.buildStudentsService.mockReturnValue(mocks.service);

  // Default service mocks
  mocks.service.listStudents.mockResolvedValue({
    data: [{ id: 'student-1', classId: 'class-1', className: '3eme A', firstName: 'Awa', lastName: 'Kouassi', isActive: true }],
    pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
  });
  mocks.service.teacherCanAccessClass.mockResolvedValue(true);
  mocks.service.createStudent.mockResolvedValue({ id: 'student-new', classId: 'class-1', className: '3eme A', firstName: 'Awa', lastName: 'Kouassi', isActive: true });
  mocks.service.getStudentDetail.mockResolvedValue({
    id: 'student-1', firstName: 'Awa', lastName: 'Kouassi', className: '3eme A', classId: 'class-1',
    isActive: true, parentPhone: '2250700000011', parentPhone2: null, parentName: null, parentName2: null,
    note: null, createdAt: '2026-04-13T10:00:00.000Z',
    absenceSummary: { total: 2, excused: 0, thisMonth: 1, thisWeek: 1 },
    recentAbsences: [], documents: [], parentSms: [],
  });
  mocks.service.updateStudent.mockResolvedValue({ id: 'student-1', isActive: true });
  mocks.service.softDeleteStudent.mockResolvedValue({ id: 'student-1', isActive: false });
  mocks.service.bulkMarkAbsences.mockResolvedValue({ createdAttendances: 3, emittedEvents: 3 });
  mocks.service.listAttendanceHistory.mockResolvedValue({
    data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
  });
  mocks.service.listTodayAbsences.mockResolvedValue([]);
  mocks.service.getAbsenceStats.mockResolvedValue([]);
  mocks.service.getStudentAbsences.mockResolvedValue([]);
  mocks.service.excuseAbsence.mockResolvedValue({
    id: 'att-1', studentId: 'student-1', date: '2026-04-13', scheduleId: 'sched-1',
    status: 'excused', excuseReason: 'Certificat médical', excusedAt: '2026-04-14T08:00:00.000Z',
  });
});

// ─── GET /students ────────────────────────────────────────────────────────────

describe('GET /api/v1/students', () => {
  it('retourne 401 sans Authorization', async () => {
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/students' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('retourne les données paginées', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/students?page=1&limit=20&search=awa',
      headers: { authorization: 'Bearer token' },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { data: unknown[]; pagination: unknown };
    expect(body.data).toHaveLength(1);
    await app.close();
  });

  it('retourne 403 pour un rôle non autorisé', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET', url: '/api/v1/students',
      headers: { authorization: 'Bearer token', 'x-test-role': 'super_admin' },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('retourne 403 pour un teacher sans class_id', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET', url: '/api/v1/students',
      headers: { authorization: 'Bearer token', 'x-test-role': 'teacher' },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('retourne 200 pour un teacher avec class_id valide', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/students?class_id=d4f72601-726f-4956-bedb-1da5193287b9',
      headers: { authorization: 'Bearer token', 'x-test-role': 'teacher' },
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.service.teacherCanAccessClass).toHaveBeenCalledWith(
      expect.objectContaining({ classId: 'd4f72601-726f-4956-bedb-1da5193287b9' })
    );
    await app.close();
  });
});

// ─── POST /students ───────────────────────────────────────────────────────────

describe('POST /api/v1/students', () => {
  it('crée un élève et retourne 201', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST', url: '/api/v1/students',
      headers: { authorization: 'Bearer token' },
      payload: {
        class_id: 'd81cecfb-6544-4651-a420-84e7ca2419c7',
        first_name: 'Awa', last_name: 'Kouassi',
        parent_phone: null,
      },
    });
    expect(response.statusCode).toBe(201);
    await app.close();
  });

  it('retourne 400 avec parent_phone invalide', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST', url: '/api/v1/students',
      headers: { authorization: 'Bearer token' },
      payload: {
        class_id: 'd81cecfb-6544-4651-a420-84e7ca2419c7',
        first_name: 'Awa', last_name: 'Kouassi',
        parent_phone: '0700000001',
      },
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as { code: string };
    expect(body.code).toBe('BAD_REQUEST');
    await app.close();
  });
});

// ─── PUT /students/:id ────────────────────────────────────────────────────────

describe('PUT /api/v1/students/:id', () => {
  it('met à jour et retourne 200', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/students/66f048d8-d053-48e2-b4a8-7fce3ebc3ed8',
      headers: { authorization: 'Bearer token' },
      payload: { first_name: 'Awa Modifiée' },
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.service.updateStudent).toHaveBeenCalledWith(
      '66f048d8-d053-48e2-b4a8-7fce3ebc3ed8',
      expect.objectContaining({ first_name: 'Awa Modifiée' })
    );
    await app.close();
  });

  it('retourne 400 si aucun champ fourni', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/students/66f048d8-d053-48e2-b4a8-7fce3ebc3ed8',
      headers: { authorization: 'Bearer token' },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

// ─── DELETE /students/:id ─────────────────────────────────────────────────────

describe('DELETE /api/v1/students/:id', () => {
  it('désactive un élève et retourne 200', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/students/66f048d8-d053-48e2-b4a8-7fce3ebc3ed8',
      headers: { authorization: 'Bearer token' },
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.service.softDeleteStudent).toHaveBeenCalledWith(
      '66f048d8-d053-48e2-b4a8-7fce3ebc3ed8'
    );
    await app.close();
  });

  it('retourne 404 si introuvable', async () => {
    const { StudentsModuleError } = await import('../../src/modules/students/students.service.js');
    mocks.service.softDeleteStudent.mockRejectedValue(
      new StudentsModuleError('Student not found', 404, 'STUDENT_NOT_FOUND')
    );
    const app = await buildApp();
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/students/66f048d8-d053-48e2-b4a8-7fce3ebc3ed8',
      headers: { authorization: 'Bearer token' },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

// ─── GET /students/:id ────────────────────────────────────────────────────────

describe('GET /api/v1/students/:id', () => {
  it('retourne le détail élève', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/students/66f048d8-d053-48e2-b4a8-7fce3ebc3ed8',
      headers: { authorization: 'Bearer token' },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { data: { absenceSummary: { excused: number } } };
    expect(body.data.absenceSummary.excused).toBe(0);
    await app.close();
  });
});

// ─── GET /students/absence-stats ─────────────────────────────────────────────

describe('GET /api/v1/students/absence-stats', () => {
  it('appelle le service stats (route statique prioritaire sur /:id)', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/students/absence-stats?from=2026-04-01&to=2026-04-30&min_absences=2',
      headers: { authorization: 'Bearer token' },
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.service.getAbsenceStats).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-04-01', to: '2026-04-30', min_absences: 2 })
    );
    expect(mocks.service.getStudentDetail).not.toHaveBeenCalledWith('absence-stats');
    await app.close();
  });

  it('retourne 400 si from ou to manquants', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/students/absence-stats',
      headers: { authorization: 'Bearer token' },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

// ─── GET /students/:studentId/absences ────────────────────────────────────────

describe('GET /api/v1/students/:studentId/absences', () => {
  it('appelle le service détail absences', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/students/66f048d8-d053-48e2-b4a8-7fce3ebc3ed8/absences?from=2026-04-01&to=2026-04-30&subject=Math',
      headers: { authorization: 'Bearer token' },
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.service.getStudentAbsences).toHaveBeenCalledWith(
      '66f048d8-d053-48e2-b4a8-7fce3ebc3ed8',
      { from: '2026-04-01', to: '2026-04-30', subject: 'Math' }
    );
    await app.close();
  });
});

// ─── PATCH /students/absences/:attendanceId/excuse ────────────────────────────

describe('PATCH /api/v1/students/absences/:attendanceId/excuse', () => {
  it('excuse une absence et retourne 200', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/students/absences/66f048d8-d053-48e2-b4a8-7fce3ebc3ed8/excuse',
      headers: { authorization: 'Bearer token' },
      payload: { reason: 'Certificat médical' },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { data: { status: string } };
    expect(body.data.status).toBe('excused');
    expect(mocks.service.excuseAbsence).toHaveBeenCalledWith(
      '66f048d8-d053-48e2-b4a8-7fce3ebc3ed8',
      { reason: 'Certificat médical' },
      'user-1'
    );
    await app.close();
  });

  it('retourne 400 si reason manquante', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/students/absences/66f048d8-d053-48e2-b4a8-7fce3ebc3ed8/excuse',
      headers: { authorization: 'Bearer token' },
      payload: { reason: '' },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('retourne 404 si absence introuvable', async () => {
    const { StudentsModuleError } = await import('../../src/modules/students/students.service.js');
    mocks.service.excuseAbsence.mockRejectedValue(
      new StudentsModuleError('Absence not found', 404, 'ABSENCE_NOT_FOUND')
    );
    const app = await buildApp();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/students/absences/66f048d8-d053-48e2-b4a8-7fce3ebc3ed8/excuse',
      headers: { authorization: 'Bearer token' },
      payload: { reason: 'Maladie' },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('retourne 409 si déjà excusée', async () => {
    const { StudentsModuleError } = await import('../../src/modules/students/students.service.js');
    mocks.service.excuseAbsence.mockRejectedValue(
      new StudentsModuleError('Absence already excused', 409, 'ALREADY_EXCUSED')
    );
    const app = await buildApp();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/students/absences/66f048d8-d053-48e2-b4a8-7fce3ebc3ed8/excuse',
      headers: { authorization: 'Bearer token' },
      payload: { reason: 'Maladie' },
    });
    expect(response.statusCode).toBe(409);
    await app.close();
  });

  it('retourne 403 sans permission students.excuse', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/students/absences/66f048d8-d053-48e2-b4a8-7fce3ebc3ed8/excuse',
      headers: {
        authorization: 'Bearer token',
        'x-test-permissions': 'students.view',
      },
      payload: { reason: 'Maladie' },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});

// ─── POST /attendance/students/bulk ───────────────────────────────────────────

describe('POST /api/v1/attendance/students/bulk', () => {
  it('appelle le service bulk', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST', url: '/api/v1/attendance/students/bulk',
      headers: { authorization: 'Bearer token' },
      payload: {
        scheduleId: 'd81cecfb-6544-4651-a420-84e7ca2419c7',
        date: '2026-04-13',
        absences: [
          '66f048d8-d053-48e2-b4a8-7fce3ebc3ed8',
          '50049931-f1cd-4e3b-8f7f-a20567e85e77',
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.service.bulkMarkAbsences).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('retourne 400 si scheduleId invalide', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST', url: '/api/v1/attendance/students/bulk',
      headers: { authorization: 'Bearer token' },
      payload: { scheduleId: 'not-a-uuid', date: '2026-04-13', absences: [] },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

// ─── GET /attendance/students ─────────────────────────────────────────────────

describe('GET /api/v1/attendance/students', () => {
  it('transmet les filtres au service', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/attendance/students?schedule_id=d81cecfb-6544-4651-a420-84e7ca2419c7&student_id=66f048d8-d053-48e2-b4a8-7fce3ebc3ed8&page=1&limit=20',
      headers: { authorization: 'Bearer token' },
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.service.listAttendanceHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        schedule_id: 'd81cecfb-6544-4651-a420-84e7ca2419c7',
        student_id: '66f048d8-d053-48e2-b4a8-7fce3ebc3ed8',
      })
    );
    await app.close();
  });
});

// ─── GET /attendance/students/today ───────────────────────────────────────────

describe('GET /api/v1/attendance/students/today', () => {
  it('retourne la liste des absences du jour', async () => {
    mocks.service.listTodayAbsences.mockResolvedValue([
      { classId: 'class-1', className: '3eme A', absences: [{ studentId: 'student-1', status: 'absent' }] },
    ]);

    const app = await buildApp();
    const response = await app.inject({
      method: 'GET', url: '/api/v1/attendance/students/today',
      headers: { authorization: 'Bearer token' },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { data: unknown[] };
    expect(body.data).toHaveLength(1);
    await app.close();
  });
});
