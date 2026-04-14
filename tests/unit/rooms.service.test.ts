import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RoomsModuleError, RoomsService } from '../../src/modules/rooms/rooms.service.js';
import type { RoomsRepository } from '../../src/modules/rooms/rooms.repository.js';

const baseRoom = {
  id: 'room-1',
  name: 'Salle A1',
  qrToken: 'a'.repeat(64),
  building: 'Bloc A',
  capacity: 40,
  isActive: true,
  createdAt: '2026-04-14T00:00:00.000Z',
};

const mockRepo = {
  findRoomById: vi.fn(),
  hasFutureActiveSchedules: vi.fn(),
  softDeleteRoom: vi.fn(),
  createRoom: vi.fn(),
  updateRoom: vi.fn(),
  regenerateRoomToken: vi.fn(),
  listActiveRoomsWithStats: vi.fn(),
  findRoomByToken: vi.fn(),
} as unknown as Record<keyof RoomsRepository, ReturnType<typeof vi.fn>>;

const service = new RoomsService(mockRepo as unknown as RoomsRepository);

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.QR_SCAN_BASE_URL;
});

describe('rooms.service', () => {
  it('deleteRoom -> 404 si room non trouvée', async () => {
    mockRepo.findRoomById.mockResolvedValue(null);

    await expect(service.deleteRoom('missing')).rejects.toMatchObject<Partial<RoomsModuleError>>({
      message: 'Room not found',
      statusCode: 404,
      code: 'ROOM_NOT_FOUND',
    });
  });

  it('deleteRoom -> 409 ROOM_HAS_FUTURE_SCHEDULES si future schedules actives', async () => {
    mockRepo.findRoomById.mockResolvedValue(baseRoom);
    mockRepo.hasFutureActiveSchedules.mockResolvedValue(true);

    await expect(service.deleteRoom('room-1')).rejects.toMatchObject<Partial<RoomsModuleError>>({
      message: 'Room has active future schedules and cannot be deleted',
      statusCode: 409,
      code: 'ROOM_HAS_FUTURE_SCHEDULES',
    });
  });

  it('deleteRoom -> soft delete et retourne room sans qrToken', async () => {
    mockRepo.findRoomById.mockResolvedValue(baseRoom);
    mockRepo.hasFutureActiveSchedules.mockResolvedValue(false);
    mockRepo.softDeleteRoom.mockResolvedValue({ ...baseRoom, isActive: false });

    const result = await service.deleteRoom('room-1');

    expect(mockRepo.softDeleteRoom).toHaveBeenCalledWith('room-1');
    expect(result).toMatchObject({
      id: 'room-1',
      name: 'Salle A1',
      isActive: false,
    });
    expect(result).not.toHaveProperty('qrToken');
  });

  it('createRoom -> retourne une room sans qrToken', async () => {
    mockRepo.createRoom.mockResolvedValue(baseRoom);

    const result = await service.createRoom({
      name: 'Salle A1',
      building: 'Bloc A',
      capacity: 40,
    });

    expect(mockRepo.createRoom).toHaveBeenCalled();
    expect(result).toMatchObject({
      id: 'room-1',
      name: 'Salle A1',
    });
    expect(result).not.toHaveProperty('qrToken');
  });

  it('updateRoom -> 404 si room non trouvée', async () => {
    mockRepo.updateRoom.mockResolvedValue(null);

    await expect(service.updateRoom('missing', { name: 'Salle B1' })).rejects.toMatchObject<
      Partial<RoomsModuleError>
    >({
      message: 'Room not found',
      statusCode: 404,
      code: 'ROOM_NOT_FOUND',
    });
  });

  it('regenerateToken -> retourne { room, qr_url } avec token dans qr_url', async () => {
    mockRepo.findRoomById.mockResolvedValue(baseRoom);
    mockRepo.regenerateRoomToken.mockImplementation(async (_id: string, token: string) => ({
      ...baseRoom,
      qrToken: token,
    }));

    const result = await service.regenerateToken('room-1');

    expect(result.room).toHaveProperty('qrToken');
    expect(result.qr_url).toContain(result.room.qrToken);
    expect(result.qr_url).toContain('/scan?token=');
  });

  it('buildQrUrl via regenerateToken -> URL correcte si QR_SCAN_BASE_URL=https://app.edutrack.ci', async () => {
    process.env.QR_SCAN_BASE_URL = 'https://app.edutrack.ci';
    mockRepo.findRoomById.mockResolvedValue(baseRoom);
    mockRepo.regenerateRoomToken.mockImplementation(async (_id: string, token: string) => ({
      ...baseRoom,
      qrToken: token,
    }));

    const result = await service.regenerateToken('room-1');

    expect(result.qr_url).toBe(`https://app.edutrack.ci/scan?token=${result.room.qrToken}`);
  });
});
