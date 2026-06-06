import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withTenantSchema: vi.fn(),
  requireTeacher: vi.fn(),
  buildAttendanceService: vi.fn(),
  qrScan: vi.fn(),
  smsQueue: { add: vi.fn() },
}));

vi.mock('../../src/shared/database/db.js', () => ({
  withTenantSchema: mocks.withTenantSchema,
}));

vi.mock('../../src/shared/middleware/auth.middleware.js', () => ({
  requireTeacher: mocks.requireTeacher,
  requireDirector: vi.fn(),
  requireTeacherOrDirector: vi.fn(),
  requirePermission: vi.fn(),
  authenticateRequest: vi.fn(),
  requireDirectorOrSecretary: vi.fn(),
  requireTeacherOrDirectorOrSecretary: vi.fn(),
}));

vi.mock('../../src/modules/attendance/attendance.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/modules/attendance/attendance.service.js')
  >('../../src/modules/attendance/attendance.service.js');
  return {
    ...actual,
    buildAttendanceService: mocks.buildAttendanceService,
  };
});

vi.mock('../../src/shared/queue/queue.js', () => ({
  smsQueue: mocks.smsQueue,
}));

import attendanceController from '../../src/modules/attendance/attendance.controller.js';

const VALID_QR_TOKEN = 'a'.repeat(64);
const VALID_SCHEDULE_ID = '11111111-1111-4111-8111-111111111111';

const buildApp = async () => {
  const app = Fastify();
  await app.register(attendanceController);
  await app.ready();
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();

  mocks.requireTeacher.mockImplementation(
    async (request: { claims?: unknown }, _reply: unknown, done: () => void) => {
      request.claims = {
        sub: 'teacher-user-id',
        role: 'teacher',
        schemaName: 'school_test',
      };
      done();
    }
  );

  mocks.withTenantSchema.mockImplementation(async (_schemaName, callback) => {
    return await callback({ execute: vi.fn() });
  });

  mocks.buildAttendanceService.mockReturnValue({
    qrScan: mocks.qrScan,
    checkIn: vi.fn(),
    skipQrStep: vi.fn(),
    bulkStudentAttendance: vi.fn(),
    getDailyAttendanceForTeacher: vi.fn(),
    getWeeklyScheduleForTeacher: vi.fn(),
  });

  mocks.qrScan.mockResolvedValue({
    valid: true,
    roomMismatch: false,
    alertType: null,
    lateMinutes: 0,
  });
});

describe('POST /api/v1/attendance/qr-scan', () => {
  it('scan valide (start) → 200 + données retournées', async () => {
    mocks.qrScan.mockResolvedValueOnce({
      valid: true,
      roomMismatch: false,
      alertType: null,
      lateMinutes: 5,
    });

    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/attendance/qr-scan',
      payload: {
        qr_token: VALID_QR_TOKEN,
        scan_type: 'start',
        schedule_id: VALID_SCHEDULE_ID,
        date: '2026-05-09',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.valid).toBe(true);
    expect(body.data.roomMismatch).toBe(false);
    expect(mocks.qrScan).toHaveBeenCalled();
    await app.close();
  });

  it('scan avec mauvaise salle → 200 + roomMismatch=true + alertType teacher_qr_mismatch', async () => {
    mocks.qrScan.mockResolvedValueOnce({
      valid: false,
      roomMismatch: true,
      alertType: 'teacher_qr_mismatch',
      lateMinutes: null,
    });

    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/attendance/qr-scan',
      payload: {
        qr_token: VALID_QR_TOKEN,
        scan_type: 'start',
        schedule_id: VALID_SCHEDULE_ID,
        date: '2026-05-09',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.roomMismatch).toBe(true);
    expect(body.data.alertType).toBe('teacher_qr_mismatch');
    await app.close();
  });

  it('scan hors fenêtre horaire → 200 + alertType teacher_qr_scan_out_of_time', async () => {
    mocks.qrScan.mockResolvedValueOnce({
      valid: false,
      roomMismatch: false,
      alertType: 'teacher_qr_scan_out_of_time',
      lateMinutes: null,
    });

    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/attendance/qr-scan',
      payload: {
        qr_token: VALID_QR_TOKEN,
        scan_type: 'start',
        schedule_id: VALID_SCHEDULE_ID,
        date: '2026-05-09',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.alertType).toBe('teacher_qr_scan_out_of_time');
    await app.close();
  });

  it('scan sans auth → requireTeacher bloque avec 401', async () => {
    mocks.requireTeacher.mockImplementationOnce(
      async (_request: unknown, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
        reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED', statusCode: 401 });
      }
    );

    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/attendance/qr-scan',
      payload: {
        qr_token: VALID_QR_TOKEN,
        scan_type: 'start',
        schedule_id: VALID_SCHEDULE_ID,
      },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('qr_token trop court → 400', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/attendance/qr-scan',
      payload: {
        qr_token: 'too-short',
        scan_type: 'start',
        schedule_id: VALID_SCHEDULE_ID,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(mocks.qrScan).not.toHaveBeenCalled();
    await app.close();
  });

  it('scan_type invalide → 400', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/attendance/qr-scan',
      payload: {
        qr_token: VALID_QR_TOKEN,
        scan_type: 'invalid',
        schedule_id: VALID_SCHEDULE_ID,
      },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('QR code non reconnu dans l\'établissement → 400 + QR_NOT_IN_SCHOOL', async () => {
    const { AttendanceModuleError } = await import('../../src/modules/attendance/attendance.service.js');
    mocks.qrScan.mockRejectedValueOnce(
      new AttendanceModuleError('QR code non reconnu', 400, 'QR_NOT_IN_SCHOOL')
    );

    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/attendance/qr-scan',
      payload: {
        qr_token: VALID_QR_TOKEN,
        scan_type: 'start',
        schedule_id: VALID_SCHEDULE_ID,
        date: '2026-05-09',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('QR_NOT_IN_SCHOOL');
    await app.close();
  });

  it('schedule non trouvé → 404 + SCHEDULE_NOT_FOUND', async () => {
    const { AttendanceModuleError } = await import('../../src/modules/attendance/attendance.service.js');
    mocks.qrScan.mockRejectedValueOnce(
      new AttendanceModuleError('Schedule not found', 404, 'SCHEDULE_NOT_FOUND')
    );

    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/attendance/qr-scan',
      payload: {
        qr_token: VALID_QR_TOKEN,
        scan_type: 'start',
        schedule_id: VALID_SCHEDULE_ID,
        date: '2026-05-09',
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('SCHEDULE_NOT_FOUND');
    await app.close();
  });
});
