import { z } from 'zod';

export const attendanceIdParamsSchema = z.object({
  attendanceId: z.string().uuid(),
});

export const approveValidationBodySchema = z.object({
  validated_hours: z.number().min(0).max(24).optional(),
});

export const rejectValidationBodySchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const realHoursConfigBodySchema = z.object({
  checkoutToleranceMinutes: z.number().int().min(0).max(30),
});

export type ValidationKind = 'gps_suspicious' | 'short_hours';

export type PendingValidationItem = {
  attendanceId: string;
  teacherId: string;
  teacherName: string;
  courseName: string;
  className: string;
  date: string;
  checkedInAt: string | null;
  checkedOutAt: string | null;
  geoStatus: 'verified' | 'suspicious' | 'unavailable' | 'not_checked' | null;
  checkinDistance: number | null;
  actualMinutes: number | null;
  scheduleDurationMinutes: number;
  validationReason: string | null;
  hourlyRate: number | null;
  kind: ValidationKind;
};

export type PendingValidationGroups = {
  gps_suspicious: PendingValidationItem[];
  short_hours: PendingValidationItem[];
};

export type PendingValidationCount = {
  gps_suspicious: number;
  short_hours: number;
  total: number;
};
