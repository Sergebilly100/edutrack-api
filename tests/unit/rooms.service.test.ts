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
  hasAnyActiveSchedules: vi.fn(),
  softDeleteRoom: vi.fn(),
  softDeleteRoomIfUnused: vi.fn(),
  createRoom: vi.fn(),
  updateRoom: vi.fn(),
  regenerateRoomToken: vi.fn(),
  listActiveRoomsWithStats: vi.fn(),
  findRoomByToken: vi.fn(),
} as unknown as Record<keyof RoomsRepository, ReturnType<typeof vi.fn>>;

const service = new RoomsService(mockRepo as unknown as RoomsRepository, 'tenant-1', 'school_test');

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

  it('deleteRoom -> 409 ROOM_HAS_SCHEDULES si la salle est liée à des créneaux', async () => {
    mockRepo.softDeleteRoomIfUnused.mockResolvedValue(null);
    mockRepo.findRoomById.mockResolvedValue(baseRoom);

    await expect(service.deleteRoom('room-1')).rejects.toMatchObject<Partial<RoomsModuleError>>({
      message: 'Room is used in schedule slots and cannot be deleted',
      statusCode: 409,
      code: 'ROOM_HAS_SCHEDULES',
    });
  });

  it('deleteRoom -> soft delete et retourne room sans qrToken', async () => {
    mockRepo.softDeleteRoomIfUnused.mockResolvedValue({ ...baseRoom, isActive: false });

    const result = await service.deleteRoom('room-1');

    expect(mockRepo.softDeleteRoomIfUnused).toHaveBeenCalledWith('room-1');
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

  it('createRoom -> 409 ROOM_CONFLICT si contrainte unique violée (23505)', async () => {
    const dbError = new Error('duplicate key');
    (dbError as Error & { code: string }).code = '23505';
    mockRepo.createRoom.mockRejectedValue(dbError);

    await expect(service.createRoom({ name: 'Salle A1' })).rejects.toMatchObject<Partial<RoomsModuleError>>({
      message: 'Room already exists',
      statusCode: 409,
      code: 'ROOM_CONFLICT',
    });
  });

  it('updateRoom -> 409 ROOM_CONFLICT si contrainte unique violée', async () => {
    const dbError = new Error('duplicate key');
    (dbError as Error & { code: string }).code = '23505';
    mockRepo.updateRoom.mockRejectedValue(dbError);

    await expect(service.updateRoom('room-1', { name: 'Salle B1' })).rejects.toMatchObject<
      Partial<RoomsModuleError>
    >({
      message: 'Room already exists',
      statusCode: 409,
      code: 'ROOM_CONFLICT',
    });
  });

  it('getRoomQr -> 404 si room inexistante', async () => {
    mockRepo.findRoomById.mockResolvedValue(null);

    await expect(service.getRoomQr('missing')).rejects.toMatchObject<Partial<RoomsModuleError>>({
      message: 'Room not found',
      statusCode: 404,
      code: 'ROOM_NOT_FOUND',
    });
  });

  it('getRoomQr -> retourne room_name, qr_token et qr_url', async () => {
    mockRepo.findRoomById.mockResolvedValue(baseRoom);

    const result = await service.getRoomQr('room-1');

    expect(result).toMatchObject({
      room_name: 'Salle A1',
      qr_token: baseRoom.qrToken,
    });
    expect(result.qr_url).toContain('/scan?token=');
  });

  it('listActiveRooms -> retourne liste vide si aucune salle', async () => {
    mockRepo.listActiveRoomsWithStats.mockResolvedValue([]);

    const result = await service.listActiveRooms();

    expect(result.rooms).toEqual([]);
  });

  it('deleteRoom -> soft delete atomique via softDeleteRoomIfUnused', async () => {
    mockRepo.softDeleteRoomIfUnused.mockResolvedValue({ ...baseRoom, isActive: false });

    const result = await service.deleteRoom('room-1');

    expect(mockRepo.softDeleteRoomIfUnused).toHaveBeenCalledWith('room-1');
    expect(result.isActive).toBe(false);
  });

  it('deleteRoom -> 409 ROOM_HAS_SCHEDULES si room utilisée (atomique)', async () => {
    mockRepo.softDeleteRoomIfUnused.mockResolvedValue(null);
    mockRepo.findRoomById.mockResolvedValue(baseRoom);

    await expect(service.deleteRoom('room-1')).rejects.toMatchObject<Partial<RoomsModuleError>>({
      message: 'Room is used in schedule slots and cannot be deleted',
      statusCode: 409,
      code: 'ROOM_HAS_SCHEDULES',
    });
  });
});
