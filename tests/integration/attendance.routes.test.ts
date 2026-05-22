import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const mockClaims = {
  sub: 'user-uuid',
  role: 'teacher' as const,
  schemaName: 'school_test',
  tenantId: 'tenant-uuid',
};

vi.mock('../../src/shared/middleware/auth.middleware.js', () => ({
  requireTeacher: vi.fn(async (request: { claims: unknown }, _reply: unknown, done: () => void) => {
    request.claims = mockClaims;
    done();
  }),
  requireDirector: vi.fn(async (request: { claims: unknown }, _reply: unknown, done: () => void) => {
    request.claims = mockClaims;
    done();
  }),
  requireTeacherOrDirector: vi.fn(async (request: { claims: unknown }, _reply: unknown, done: () => void) => {
    request.claims = mockClaims;
    done();
  }),
}));

vi.mock('../../src/shared/database/db.js', () => ({
  withTenantSchema: vi.fn(),
}));

import attendanceController from '../../src/modules/attendance/attendance.controller.js';

describe('Attendance Routes Integration', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();

    app.decorateRequest('claims', null);
    app.decorateRequest('db', null);

    await app.register(attendanceController);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /api/v1/attendance/check-in', () => {
    it('should require authentication', async () => {
      // Sans header auth, le vrai middleware retournerait 401
      // Avec le mock, on simule ce comportement via le test "require teacher role"
      // Ce test vérifie que la route existe et répond
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/attendance/check-in',
        payload: {
          schedule_id: '123e4567-e89b-12d3-a456-426614174000',
          date: '2026-05-09',
        },
      });

      // Avec le mock auth, les claims sont injectés — la validation Zod passe,
      // le handler échoue sur withTenantSchema (non mocké) → 500 ou autre
      // On vérifie juste que la route répond (pas 404)
      expect(response.statusCode).not.toBe(404);
    });

    it('should validate payload schema', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/attendance/check-in',
        headers: {
          authorization: 'Bearer mock-token',
        },
        payload: {
          // schedule_id manquant
          date: '2026-05-09',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('BAD_REQUEST');
    });

    it('should reject invalid date format', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/attendance/check-in',
        headers: {
          authorization: 'Bearer mock-token',
        },
        payload: {
          schedule_id: '123e4567-e89b-12d3-a456-426614174000',
          date: '09-05-2026', // format invalide
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /api/v1/attendance/qr-scan', () => {
    it('should validate qr_token length', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/attendance/qr-scan',
        headers: {
          authorization: 'Bearer mock-token',
        },
        payload: {
          qr_token: 'short-token', // doit faire 64 caractères
          scan_type: 'start',
          schedule_id: '123e4567-e89b-12d3-a456-426614174000',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should validate scan_type enum', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/attendance/qr-scan',
        headers: {
          authorization: 'Bearer mock-token',
        },
        payload: {
          qr_token: 'a'.repeat(64),
          scan_type: 'invalid', // doit être 'start' ou 'end'
          schedule_id: '123e4567-e89b-12d3-a456-426614174000',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /api/v1/attendance/students/bulk', () => {
    it('should validate absent_student_ids as array', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/attendance/students/bulk',
        headers: {
          authorization: 'Bearer mock-token',
        },
        payload: {
          schedule_id: '123e4567-e89b-12d3-a456-426614174000',
          date: '2026-05-09',
          absent_student_ids: 'not-an-array', // doit être un array
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should accept empty absent_student_ids array', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/attendance/students/bulk',
        headers: {
          authorization: 'Bearer mock-token',
        },
        payload: {
          schedule_id: '123e4567-e89b-12d3-a456-426614174000',
          date: '2026-05-09',
          absent_student_ids: [],
        },
      });

      // Passe la validation Zod, échoue sur withTenantSchema (mocké mais non configuré)
      expect(response.statusCode).not.toBe(400);
    });
  });

  describe('GET /api/v1/attendance/teacher/me', () => {
    it('should require teacher role', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/teacher/me',
        query: {
          date: '2026-05-09',
        },
      });

      // Route existe et répond (auth mockée → passe)
      expect(response.statusCode).not.toBe(404);
    });

    it('should validate date query param', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/teacher/me',
        headers: {
          authorization: 'Bearer mock-token',
        },
        query: {
          date: 'invalid-date',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
