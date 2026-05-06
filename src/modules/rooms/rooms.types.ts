import { z } from 'zod';

export const roomIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const createRoomBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  building: z.string().trim().max(100).nullable().optional(),
  capacity: z.number().int().positive().nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  geoRadius: z.number().int().min(30).max(300).nullable().optional(),
});

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
  });

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
  geoRadius: number;
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
  geoRadius: number;
  isActive: boolean;
  createdAt: string;
};
