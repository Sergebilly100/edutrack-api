import { z } from 'zod';

export const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export const checkInBodySchema = z.object({
  schedule_id: z.string().uuid(),
  date: z.string().regex(ISO_DATE_REGEX, 'date must use YYYY-MM-DD format').optional(),
});

export const qrScanBodySchema = z.object({
  qr_token: z.string().trim().length(64),
  scan_type: z.enum(['start', 'end']),
  schedule_id: z.string().uuid(),
  date: z.string().regex(ISO_DATE_REGEX, 'date must use YYYY-MM-DD format').optional(),
});

export type AttendanceScheduleContext = {
  scheduleId: string;
  teacherId: string;
  teacherName: string;
  className: string;
  subject: string;
  plannedRoomId: string;
  plannedRoomName: string;
  plannedRoomToken: string;
  timeSlotId: string;
  slotLabel: string;
  slotStartTime: string;
  slotEndTime: string;
};

export type ActiveAttendanceItem = {
  scheduleId: string;
  subject: string;
  className: string;
  roomName: string;
  timeSlot: {
    id: string;
    label: string;
    startTime: string;
    endTime: string;
  };
  attendance: {
    status: 'present' | 'absent' | 'late' | 'excused' | null;
    lateMinutes: number | null;
    roomMismatch: boolean;
    roomScannedName: string | null;
    checkedInAt: string | null;
  };
};

export type CheckInResult = {
  status: 'present' | 'absent' | 'late' | 'excused';
  lateMinutes: number | null;
  checkedInAt: string;
};
