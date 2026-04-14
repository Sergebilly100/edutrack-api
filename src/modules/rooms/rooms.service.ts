import { randomBytes } from 'node:crypto';

import type { RoomEntity, RoomItem } from './rooms.types.js';
import { RoomsRepository, mapRoomStats } from './rooms.repository.js';

export class RoomsModuleError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message);
    this.name = 'RoomsModuleError';
  }
}

const todayIso = (): string => new Date().toISOString().slice(0, 10);

const generateQrToken = (): string => randomBytes(32).toString('hex');

type PublicRoom = Omit<RoomEntity, 'qrToken'>;

const toPublicRoom = (room: RoomEntity): PublicRoom => ({
  id: room.id,
  name: room.name,
  building: room.building,
  capacity: room.capacity,
  isActive: room.isActive,
  createdAt: room.createdAt,
});

const buildQrUrl = (token: string): string => {
  const base = process.env.QR_SCAN_BASE_URL;
  if (!base) {
    return `https://app.edutrack.ci/scan?token=${token}`;
  }

  try {
    const parsed = new URL(base);
    return `${parsed.origin}/scan?token=${token}`;
  } catch {
    return `https://app.edutrack.ci/scan?token=${token}`;
  }
};

const isDbConstraintError = (error: unknown, code: string): boolean => {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }

  return (error as { code?: string }).code === code;
};

export class RoomsService {
  constructor(private readonly repository: RoomsRepository) {}

  async listActiveRooms(): Promise<{ rooms: RoomItem[] }> {
    const rows = await this.repository.listActiveRoomsWithStats(todayIso());
    return { rooms: rows.map(mapRoomStats) };
  }

  async createRoom(input: {
    name: string;
    building?: string | null;
    capacity?: number | null;
  }): Promise<PublicRoom> {
    try {
      const room = await this.repository.createRoom({
        ...input,
        qrToken: generateQrToken(),
      });
      return toPublicRoom(room);
    } catch (error) {
      if (isDbConstraintError(error, '23505')) {
        throw new RoomsModuleError('Room already exists', 409, 'ROOM_CONFLICT');
      }

      throw error;
    }
  }

  async updateRoom(
    roomId: string,
    input: {
      name?: string;
      building?: string | null;
      capacity?: number | null;
    }
  ): Promise<PublicRoom> {
    try {
      const room = await this.repository.updateRoom(roomId, input);
      if (!room) {
        throw new RoomsModuleError('Room not found', 404, 'ROOM_NOT_FOUND');
      }

      return toPublicRoom(room);
    } catch (error) {
      if (error instanceof RoomsModuleError) {
        throw error;
      }

      if (isDbConstraintError(error, '23505')) {
        throw new RoomsModuleError('Room already exists', 409, 'ROOM_CONFLICT');
      }

      throw error;
    }
  }

  async deleteRoom(roomId: string): Promise<PublicRoom> {
    const today = todayIso();
    const room = await this.repository.findRoomById(roomId);
    if (!room) {
      throw new RoomsModuleError('Room not found', 404, 'ROOM_NOT_FOUND');
    }

    const blocked = await this.repository.hasFutureActiveSchedules(roomId, today);
    if (blocked) {
      throw new RoomsModuleError(
        'Room has active future schedules and cannot be deleted',
        409,
        'ROOM_HAS_FUTURE_SCHEDULES'
      );
    }

    const deleted = await this.repository.softDeleteRoom(roomId);
    if (!deleted) {
      throw new RoomsModuleError('Room not found', 404, 'ROOM_NOT_FOUND');
    }

    return toPublicRoom(deleted);
  }

  async regenerateToken(roomId: string) {
    const room = await this.repository.findRoomById(roomId);
    if (!room) {
      throw new RoomsModuleError('Room not found', 404, 'ROOM_NOT_FOUND');
    }

    const updated = await this.repository.regenerateRoomToken(roomId, generateQrToken());
    if (!updated) {
      throw new RoomsModuleError('Room not found', 404, 'ROOM_NOT_FOUND');
    }

    return {
      room: updated,
      qr_url: buildQrUrl(updated.qrToken),
    };
  }

  async getRoomQr(roomId: string): Promise<{ room_name: string; qr_token: string; qr_url: string }> {
    const room = await this.repository.findRoomById(roomId);
    if (!room) {
      throw new RoomsModuleError('Room not found', 404, 'ROOM_NOT_FOUND');
    }

    return {
      room_name: room.name,
      qr_token: room.qrToken,
      qr_url: buildQrUrl(room.qrToken),
    };
  }
}

export const buildRoomsService = (db: ConstructorParameters<typeof RoomsRepository>[0]) =>
  new RoomsService(new RoomsRepository(db));
