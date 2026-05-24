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
  slotLabel: string | null;
  roomName: string | null;
};

export type PendingValidationGroups = {
  gps_suspicious: PendingValidationItem[];
  short_hours: PendingValidationItem[];
};

export type PendingValidationCount = {
  gps_suspicious: number;
  short_hours: number;
  missing_end_scan: number;
  total: number;
};

// ── Missing end-scan types ──────────────────────────────────────────────────

export const missingEndScansQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
});

export const bulkWarnEndScansBodySchema = z.object({
  teacher_ids: z.array(z.string().uuid()).min(1).max(200),
  month: z.string().regex(/^\d{4}-\d{2}$/),
});

export const invalidateSessionBodySchema = z.object({
  attendance_id: z.string().uuid(),
  reason: z.string().trim().min(3).max(500),
});

export const endScanActionBodySchema = z.object({
  attendance_id: z.string().uuid(),
  action: z.enum(['warned', 'sanctioned']),
  reason: z.string().trim().min(3).max(500),
});

export const cancelEndScanSanctionBodySchema = z.object({
  attendance_id: z.string().uuid(),
  reason: z.string().trim().min(3).max(500),
});

export const notificationIdParamsSchema = z.object({
  notificationId: z.string().uuid(),
});

export const validationHistoryQuerySchema = z.object({
  kind: z.enum(['short_hours', 'gps_suspicious']).optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  status: z.enum(['approved', 'rejected']).optional(),
  approvalType: z.enum(['planned', 'actual']).optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ValidationHistoryItem = {
  attendanceId: string;
  teacherId: string;
  teacherName: string;
  courseName: string;
  className: string;
  date: string;
  validationStatus: 'approved' | 'rejected';
  validatedHours: number | null;
  validationReason: string | null;
  validatedAt: string | null;
  kind: ValidationKind;
  slotLabel: string | null;
  roomName: string | null;
  scheduleDurationMinutes: number;
  actualMinutes: number | null;
  hourlyRate: number | null;
};

export type ValidationHistoryPage = {
  items: ValidationHistoryItem[];
  total: number;
  page: number;
  limit: number;
};

export type TeacherNotificationItem = {
  id: string;
  type: string;
  message: string;
  createdAt: string;
  readAt: string | null;
  metadata: Record<string, unknown> | null;
};

export type EndScanAction = 'warned' | 'sanctioned';

export type MissingEndScanSession = {
  date: string;
  scheduleId: string;
  attendanceId: string;
  subject: string;
  timeSlot: string;
  roomName: string | null;
  startScanAt: string | null;
  endScanAction: EndScanAction | null;
  endScanActionReason: string | null;
  endScanActionAt: string | null;
  endScanActionCancelledAt: string | null;
  scheduleDurationMinutes: number;
};

export type MissingEndScanTeacher = {
  teacherId: string;
  teacherName: string;
  hourlyRate: number | null;
  missingEndScanCount: number;
  warningCount: number;
  sanctionCount: number;
  sessions: MissingEndScanSession[];
};
