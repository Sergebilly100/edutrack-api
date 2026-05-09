import { z } from 'zod';

export const roomIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const createRoomBodySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    building: z.string().trim().max(100).nullable().optional(),
    capacity: z.number().int().positive().nullable().optional(),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    // geoRadius peut être null pour désactiver le géofencing
    geoRadius: z.number().int().min(30).max(300).nullable().optional(),
  })
  .refine(
    (data) => {
      // Les deux coordonnées GPS doivent être définies ensemble, ou aucune
      const hasLatitude = data.latitude !== null && data.latitude !== undefined;
      const hasLongitude = data.longitude !== null && data.longitude !== undefined;
      return (hasLatitude && hasLongitude) || (!hasLatitude && !hasLongitude);
    },
    {
      message: 'Latitude and longitude must both be provided or both be null',
      path: ['latitude'],
    }
  );

export const updateRoomBodySchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    building: z.string().trim().max(100).nullable().optional(),
    capacity: z.number().int().positive().nullable().optional(),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    geoRadius: z.number().int().min(30).max(300).nullable().optional(),
  })
  .refine((payload) => Object.values(payload).some((value) => value !== undefined), {
    message: 'At least one field is required',
  })
  .refine(
    (data) => {
      // Si on met à jour une coordonnée, vérifier la cohérence
      const hasLatitude = data.latitude !== undefined;
      const hasLongitude = data.longitude !== undefined;
      // Si une seule est définie (et pas les deux), c'est invalide
      if (hasLatitude && !hasLongitude && data.latitude !== null) {
        return false;
      }
      if (hasLongitude && !hasLatitude && data.longitude !== null) {
        return false;
      }
      return true;
    },
    {
      message: 'When updating GPS coordinates, both latitude and longitude must be provided together',
      path: ['latitude'],
    }
  );

export type CreateRoomInput = z.infer<typeof createRoomBodySchema>;
export type UpdateRoomInput = z.infer<typeof updateRoomBodySchema>;

export type RoomStatsRow = {
  id: string;
  name: string;
  building: string | null;
  capacity: number | null;
  latitude: string | number | null;
  longitude: string | number | null;
  geo_radius: number | null;
  is_active: boolean;
  created_at: Date;
  weekly_schedules_count: string | number;
  scans_count: string | number;
};

export type RoomItem = {
  id: string;
  name: string;
  building: string | null;
  capacity: number | null;
  latitude: number | null;
  longitude: number | null;
  geoRadius: number | null; // null = géofencing désactivé
  isActive: boolean;
  createdAt: string;
  stats: {
    weeklySchedulesCount: number;
    scansCount: number;
  };
};

export type RoomEntityRow = {
  id: string;
  name: string;
  qr_token: string;
  building: string | null;
  capacity: number | null;
  latitude: string | number | null;
  longitude: string | number | null;
  geo_radius: number | null;
  is_active: boolean;
  created_at: Date;
};

export type RoomEntity = {
  id: string;
  name: string;
  qrToken: string;
  building: string | null;
  capacity: number | null;
  latitude: number | null;
  longitude: number | null;
  geoRadius: number | null; // null = géofencing désactivé
  isActive: boolean;
  createdAt: string;
};
