import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withTenantSchema: vi.fn(),
  requireDirectorOrSecretary: vi.fn(),
  requireTeacherOrDirectorOrSecretary: vi.fn(),
  buildRoomsService: vi.fn(),
  listActiveRooms: vi.fn(),
  createRoom: vi.fn(),
  updateRoom: vi.fn(),
  deleteRoom: vi.fn(),
  regenerateToken: vi.fn(),
  getRoomQr: vi.fn(),
}));

vi.mock('../../src/shared/database/db.js', () => ({
  withTenantSchema: mocks.withTenantSchema,
}));

vi.mock('../../src/shared/middleware/auth.middleware.js', () => ({
  requireDirectorOrSecretary: mocks.requireDirectorOrSecretary,
  requireTeacherOrDirectorOrSecretary: mocks.requireTeacherOrDirectorOrSecretary,
}));

vi.mock('../../src/modules/rooms/rooms.service.js', async () => {
  const actual = await vi.importActual('../../src/modules/rooms/rooms.service.js');
  return {
    ...actual,
    buildRoomsService: mocks.buildRoomsService,
  };
});

import roomsController from '../../src/modules/rooms/rooms.controller.js';

const ROOM_ID = '11111111-1111-4111-8111-111111111111';

const buildApp = async () => {
  const app = Fastify();
  await app.register(roomsController);
  await app.ready();
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();

  mocks.requireDirectorOrSecretary.mockImplementation(async (request: { claims?: unknown }) => {
    request.claims = {
      sub: 'director-id',
      role: 'director',
      schemaName: 'school_sainte_marie',
    };
  });
  mocks.requireTeacherOrDirectorOrSecretary.mockImplementation(async (request: { claims?: unknown }) => {
    request.claims = {
      sub: 'teacher-id',
      role: 'teacher',
      schemaName: 'school_sainte_marie',
    };
  });

  mocks.withTenantSchema.mockImplementation(async (_schemaName, callback) => callback({ execute: vi.fn() }));
  mocks.buildRoomsService.mockReturnValue({
    listActiveRooms: mocks.listActiveRooms,
    createRoom: mocks.createRoom,
    updateRoom: mocks.updateRoom,
    deleteRoom: mocks.deleteRoom,
    regenerateToken: mocks.regenerateToken,
    getRoomQr: mocks.getRoomQr,
  });

  mocks.listActiveRooms.mockResolvedValue({ rooms: [] });
  mocks.createRoom.mockResolvedValue({
    id: ROOM_ID,
    name: 'Salle Test',
    building: null,
    capacity: 30,
    isActive: true,
    createdAt: '2026-04-23T00:00:00.000Z',
  });
  mocks.updateRoom.mockResolvedValue({
    id: ROOM_ID,
    name: 'Salle Test MAJ',
    building: null,
    capacity: 35,
    isActive: true,
    createdAt: '2026-04-23T00:00:00.000Z',
  });
  mocks.deleteRoom.mockResolvedValue({
    id: ROOM_ID,
    name: 'Salle Test MAJ',
    building: null,
    capacity: 35,
    isActive: false,
    createdAt: '2026-04-23T00:00:00.000Z',
  });
  mocks.regenerateToken.mockResolvedValue({
    room: {
      id: ROOM_ID,
      name: 'Salle Test MAJ',
      qrToken: 'abc123',
    },
    qr_url: 'https://app.edutrack.ci/scan?token=abc123',
  });
  mocks.getRoomQr.mockResolvedValue({
    room_name: 'Salle Test MAJ',
    qr_token: 'abc123',
    qr_url: 'https://app.edutrack.ci/scan?token=abc123',
  });
});

describe('rooms routes', () => {
  it('GET /api/v1/rooms retourne la liste des salles', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/rooms',
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.listActiveRooms).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('POST /api/v1/rooms crée une salle', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/rooms',
      payload: {
        name: 'Salle Test',
        capacity: 30,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().room.id).toBe(ROOM_ID);
    expect(mocks.createRoom).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('POST /api/v1/rooms retourne 400 si payload invalide', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/rooms',
      payload: {
        name: '',
        capacity: -1,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(mocks.createRoom).not.toHaveBeenCalled();
    await app.close();
  });

  it('PUT /api/v1/rooms/:id met à jour une salle', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/rooms/${ROOM_ID}`,
      payload: {
        name: 'Salle Test MAJ',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().room.name).toBe('Salle Test MAJ');
    expect(mocks.updateRoom).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('DELETE /api/v1/rooms/:id supprime (soft delete) une salle', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/rooms/${ROOM_ID}`,
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.deleteRoom).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('POST /api/v1/rooms/:id/regenerate-token régénère le token QR', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${ROOM_ID}/regenerate-token`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().qr_url).toContain('scan?token=');
    expect(mocks.regenerateToken).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('GET /api/v1/rooms/:id/qr retourne les infos QR de la salle', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${ROOM_ID}/qr`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().room_name).toBe('Salle Test MAJ');
    expect(mocks.getRoomQr).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('GET /api/v1/rooms retourne 403 si le middleware refuse', async () => {
    mocks.requireTeacherOrDirectorOrSecretary.mockImplementationOnce(async (_request, reply) => {
      reply.code(403).send({
        error: 'Forbidden',
        code: 'FORBIDDEN',
        statusCode: 403,
      });
    });

    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/rooms',
    });

    expect(response.statusCode).toBe(403);
    expect(mocks.listActiveRooms).not.toHaveBeenCalled();
    await app.close();
  });
});
