import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireDirectorOrSecretary: vi.fn(),
  requireTeacherOrDirectorOrSecretary: vi.fn(),
  authenticateRequest: vi.fn(),
  attachTenantDb: vi.fn(),
  releaseTenantDb: vi.fn(),
  getActiveSchedulesForDate: vi.fn(),
  duplicatePeriod: vi.fn(),
  ensureScheduleTemporalColumns: vi.fn(),
  listSchedulePeriods: vi.fn(),
  findTeacherIdByUserId: vi.fn(),
  findSchedulePeriodById: vi.fn(),
  createSchedule: vi.fn(),
}));

vi.mock('../../src/shared/middleware/auth.middleware.js', () => ({
  authenticateRequest: mocks.authenticateRequest,
  requireDirectorOrSecretary: mocks.requireDirectorOrSecretary,
  requireTeacherOrDirectorOrSecretary: mocks.requireTeacherOrDirectorOrSecretary,
  requirePermission: vi.fn(),
  requireTeacher: vi.fn(),
  requireDirector: vi.fn(),
}));

vi.mock('../../src/shared/middleware/tenant.middleware.js', () => ({
  attachTenantDb: mocks.attachTenantDb,
  releaseTenantDb: mocks.releaseTenantDb,
}));

vi.mock('../../src/modules/schedule/schedule.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/modules/schedule/schedule.service.js')
  >('../../src/modules/schedule/schedule.service.js');
  return {
    ...actual,
    getActiveSchedulesForDate: mocks.getActiveSchedulesForDate,
    duplicatePeriod: mocks.duplicatePeriod,
    getWeeklySchedulesForDate: vi.fn().mockResolvedValue({
      date: '2026-05-09',
      period: null,
      schedules: [],
      teachers: [],
      classes: [],
      rooms: [],
      timeSlots: [],
    }),
    hasFutureOccurrenceInPeriod: vi.fn().mockResolvedValue(false),
    computeOneShotEndDate: vi.fn().mockReturnValue('2026-05-31'),
    resolveTimeSlotId: vi.fn().mockResolvedValue('timeslot-id'),
    createPeriodFromInput: vi.fn().mockResolvedValue({ id: 'period-id', name: 'T1' }),
  };
});

vi.mock('../../src/modules/schedule/schedule.repository.js', async () => ({
  listSchedulePeriods: mocks.listSchedulePeriods,
  listActiveSchedulePeriods: vi.fn().mockResolvedValue([]),
  ensureScheduleTemporalColumns: mocks.ensureScheduleTemporalColumns,
  findTeacherIdByUserId: mocks.findTeacherIdByUserId,
  findSchedulePeriodById: mocks.findSchedulePeriodById,
  findTimeSlotById: vi.fn().mockResolvedValue({ id: 'timeslot-id', startTime: '08:00', endTime: '09:00' }),
  createSchedule: mocks.createSchedule,
  updateSchedule: vi.fn().mockResolvedValue(null),
  deleteScheduleById: vi.fn().mockResolvedValue({ deleted: true }),
  hasAnyAttendanceForSchedule: vi.fn().mockResolvedValue(false),
  hasScheduleOccurrenceBeforeDate: vi.fn().mockResolvedValue(false),
  findScheduleConflicts: vi.fn().mockResolvedValue([]),
  addScheduleException: vi.fn().mockResolvedValue({}),
  closeScheduleAtDate: vi.fn().mockResolvedValue({}),
  updateSchedulePeriod: vi.fn().mockResolvedValue({}),
}));

import scheduleController from '../../src/modules/schedule/schedule.controller.js';

const PERIOD_ID = '22222222-2222-4222-8222-222222222222';

const TEACHER_CLAIMS = {
  sub: 'teacher-user-id',
  role: 'teacher' as const,
  schemaName: 'school_test',
};

const DIRECTOR_CLAIMS = {
  sub: 'director-user-id',
  role: 'director' as const,
  schemaName: 'school_test',
};

const mockTenantDb = { execute: vi.fn() };

const buildApp = async () => {
  const app = Fastify();
  app.decorateRequest('db', null);
  app.decorateRequest('tenantDbRelease', null);
  app.decorateRequest('user', null);
  app.decorateRequest('claims', null);
  await app.register(scheduleController);
  await app.ready();
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();

  mocks.authenticateRequest.mockImplementation(
    async (request: { user?: unknown; claims?: unknown }, _reply: unknown, done: () => void) => {
      request.user = { userId: TEACHER_CLAIMS.sub };
      request.claims = TEACHER_CLAIMS;
      done();
    }
  );

  mocks.requireDirectorOrSecretary.mockImplementation(
    async (request: { user?: unknown; claims?: unknown }, _reply: unknown, done: () => void) => {
      request.user = { userId: DIRECTOR_CLAIMS.sub };
      request.claims = DIRECTOR_CLAIMS;
      done();
    }
  );

  mocks.requireTeacherOrDirectorOrSecretary.mockImplementation(
    async (request: { user?: unknown; claims?: unknown }, _reply: unknown, done: () => void) => {
      request.user = { userId: TEACHER_CLAIMS.sub };
      request.claims = TEACHER_CLAIMS;
      done();
    }
  );

  mocks.attachTenantDb.mockImplementation(
    async (request: { db?: unknown }) => {
      request.db = mockTenantDb;
    }
  );

  mocks.releaseTenantDb.mockImplementation(async () => {});

  mocks.ensureScheduleTemporalColumns.mockResolvedValue(undefined);
  mocks.findTeacherIdByUserId.mockResolvedValue('teacher-id');
  mocks.listSchedulePeriods.mockResolvedValue([]);
  // Période active par défaut couvrant le 2nd semestre (mode snake_case côté repo).
  mocks.findSchedulePeriodById.mockResolvedValue({
    id: PERIOD_ID,
    name: 'T2',
    valid_from: '2099-01-05',
    valid_to: '2099-06-30',
    is_active: true,
  });
  mocks.createSchedule.mockResolvedValue({ id: 'schedule-id' });

  mocks.getActiveSchedulesForDate.mockResolvedValue({
    date: '2026-05-09',
    period: { id: 'period-1', name: 'T1', validFrom: '2026-01-01', validTo: '2026-06-30' },
    schedules: [
      {
        id: 'sched-1',
        teacherName: 'Yao Marie',
        subject: 'Mathématiques',
        className: '3ème A',
        dayOfWeek: 5,
        slotLabel: '07h30 - 09h00',
      },
    ],
  });

  mocks.duplicatePeriod.mockResolvedValue({
    period: {
      id: 'new-period-id',
      name: 'Semestre 2',
      validFrom: '2026-07-01',
      validTo: '2026-12-31',
      isActive: true,
    },
    copiedCount: 12,
  });
});

describe('GET /api/v1/schedule/active', () => {
  it('retourne les créneaux de la période active du jour → 200', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/schedule/active',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.period).toBeDefined();
    expect(body.schedules).toBeInstanceOf(Array);
    expect(body.schedules[0].subject).toBe('Mathématiques');
    await app.close();
  });

  it('retourne un objet vide si aucune période active', async () => {
    mocks.getActiveSchedulesForDate.mockResolvedValueOnce({
      date: '2026-05-09',
      period: null,
      schedules: [],
    });

    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/schedule/active',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().period).toBeNull();
    expect(response.json().schedules).toHaveLength(0);
    await app.close();
  });
});

describe('GET /api/v1/schedule/teacher/me', () => {
  it('retourne les créneaux du prof connecté → 200', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/schedule/teacher/me',
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.findTeacherIdByUserId).toHaveBeenCalled();
    expect(mocks.getActiveSchedulesForDate).toHaveBeenCalled();
    await app.close();
  });

  it('retourne 401 si userId absent des claims', async () => {
    mocks.authenticateRequest.mockImplementationOnce(
      async (request: { user?: unknown }, _reply: unknown, done: () => void) => {
        request.user = undefined;
        done();
      }
    );

    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/schedule/teacher/me',
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('retourne uniquement les créneaux du prof connecté (filtre teacherId)', async () => {
    mocks.getActiveSchedulesForDate.mockResolvedValueOnce({
      date: '2026-05-09',
      period: { id: 'period-1', name: 'T1', validFrom: '2026-01-01', validTo: '2026-06-30' },
      schedules: [
        { id: 'sched-1', teacherName: 'Yao Marie', subject: 'Maths', className: '3ème A', dayOfWeek: 5, slotLabel: '07h30 - 09h00' },
      ],
    });

    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/schedule/teacher/me',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.schedules).toHaveLength(1);
    expect(body.schedules[0].teacherName).toBe('Yao Marie');
    await app.close();
  });
});

describe('POST /api/v1/schedule/periods/:id/duplicate', () => {
  it('duplique une période avec les nouvelles dates → 201', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/schedule/periods/${PERIOD_ID}/duplicate`,
      payload: {
        new_name: 'Semestre 2',
        new_valid_from: '2026-07-01',
        new_valid_to: '2026-12-31',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.period.name).toBe('Semestre 2');
    expect(body.copied_schedules_count).toBe(12);
    expect(mocks.duplicatePeriod).toHaveBeenCalledWith(
      mockTenantDb,
      PERIOD_ID,
      expect.objectContaining({
        newName: 'Semestre 2',
        newValidFrom: '2026-07-01',
        newValidTo: '2026-12-31',
      })
    );
    await app.close();
  });

  it('new_valid_from manquant → 400', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/schedule/periods/${PERIOD_ID}/duplicate`,
      payload: {
        new_name: 'Semestre 2',
        // new_valid_from manquant
        new_valid_to: '2026-12-31',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(mocks.duplicatePeriod).not.toHaveBeenCalled();
    await app.close();
  });

  it('new_valid_to antérieure à new_valid_from → 400', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/schedule/periods/${PERIOD_ID}/duplicate`,
      payload: {
        new_name: 'Semestre 2',
        new_valid_from: '2026-12-31',
        new_valid_to: '2026-07-01',
      },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe('POST /api/v1/schedule - couverture de période', () => {
  const validUuid = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
  const basePayload = {
    schedule_period_id: PERIOD_ID,
    teacher_id: validUuid('1'),
    class_id: validUuid('2'),
    room_id: validUuid('3'),
    time_slot_id: validUuid('4'),
    day_of_week: 2,
    subject: 'Mathématiques',
  };

  it('refuse un créneau dont la date est hors de la période → 400 SCHEDULE_DATE_OUTSIDE_PERIOD', async () => {
    // findSchedulePeriodById renvoie une période 2099-01-05 → 2099-06-30 (cf. beforeEach).
    // On vise une date après valid_to : la création doit être bloquée avant tout
    // le reste (évite le cours fantôme invisible).
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/schedule',
      payload: {
        ...basePayload,
        recurrence: 'one_shot',
        effective_from: '2099-09-15',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).code).toBe('SCHEDULE_DATE_OUTSIDE_PERIOD');
    expect(mocks.createSchedule).not.toHaveBeenCalled();
    await app.close();
  });
});
