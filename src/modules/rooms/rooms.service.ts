import { randomBytes } from 'node:crypto';

import { emit } from '../../shared/events/event-bus.js';
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
  latitude: room.latitude,
  longitude: room.longitude,
  geoRadius: room.geoRadius,
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
  constructor(
    private readonly repository: RoomsRepository,
    private readonly tenantId: string,
    private readonly schemaName: string
  ) {}

  async listActiveRooms(): Promise<{ rooms: RoomItem[] }> {
    const rows = await this.repository.listActiveRoomsWithStats(todayIso());
    return { rooms: rows.map(mapRoomStats) };
  }

  async createRoom(input: {
    name: string;
    building?: string | null;
    capacity?: number | null;
    latitude?: number | null;
    longitude?: number | null;
    geoRadius?: number | null;
  }): Promise<PublicRoom> {
    try {
      const room = await this.repository.createRoom({
        ...input,
        qrToken: generateQrToken(),
      });

      // Émettre événement pour audit logs
      emit('room.created', {
        tenantId: this.tenantId,
        schemaName: this.schemaName,
        roomId: room.id,
        roomName: room.name,
        createdAt: room.createdAt,
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
      latitude?: number | null;
      longitude?: number | null;
      geoRadius?: number | null;
    }
  ): Promise<PublicRoom> {
    try {
      const room = await this.repository.updateRoom(roomId, input);
      if (!room) {
        throw new RoomsModuleError('Room not found', 404, 'ROOM_NOT_FOUND');
      }

      // Émettre événement pour audit logs
      const updatedFields = Object.keys(input).filter((key) => input[key as keyof typeof input] !== undefined);
      emit('room.updated', {
        tenantId: this.tenantId,
        schemaName: this.schemaName,
        roomId: room.id,
        roomName: room.name,
        updatedFields,
      });

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
    // La vérification + soft delete doit être atomique pour éviter race condition
    // On délègue tout au repository qui fera la transaction
    const deleted = await this.repository.softDeleteRoomIfUnused(roomId);

    if (!deleted) {
      // Vérifier si la room existe
      const room = await this.repository.findRoomById(roomId);
      if (!room) {
        throw new RoomsModuleError('Room not found', 404, 'ROOM_NOT_FOUND');
      }

      // Si elle existe mais deleted = null, c'est qu'elle est utilisée
      throw new RoomsModuleError(
        'Room is used in schedule slots and cannot be deleted',
        409,
        'ROOM_HAS_SCHEDULES'
      );
    }

    // Émettre événement pour audit logs (alerte sécurité)
    emit('room.deleted', {
      tenantId: this.tenantId,
      schemaName: this.schemaName,
      roomId: deleted.id,
      roomName: deleted.name,
      deletedAt: new Date().toISOString(),
    });

    return toPublicRoom(deleted);
  }

  async regenerateToken(roomId: string) {
    const room = await this.repository.findRoomById(roomId);
    if (!room) {
      throw new RoomsModuleError('Room not found', 404, 'ROOM_NOT_FOUND');
    }

    const oldToken = room.qrToken;
    const newToken = generateQrToken();
    const updated = await this.repository.regenerateRoomToken(roomId, newToken);
    if (!updated) {
      throw new RoomsModuleError('Room not found', 404, 'ROOM_NOT_FOUND');
    }

    // Émettre événement pour audit logs (alerte sécurité - ancien QR compromis)
    emit('room.qr_regenerated', {
      tenantId: this.tenantId,
      schemaName: this.schemaName,
      roomId: updated.id,
      roomName: updated.name,
      oldToken,
      newToken,
      regeneratedAt: new Date().toISOString(),
    });

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

export const buildRoomsService = (
  db: ConstructorParameters<typeof RoomsRepository>[0],
  tenantId: string,
  schemaName: string
) => new RoomsService(new RoomsRepository(db), tenantId, schemaName);
