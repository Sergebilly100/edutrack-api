import type { AttendanceStatus } from '../types/index.js';

export type AttendanceStatusResult = {
  status: AttendanceStatus;
  lateMinutes: number | null;
};

export type RoomScanValidationInput = {
  scannedRoomToken: string;
  expectedRoomToken: string;
  scheduleDate: string;
  slotStartTime: string;
  slotEndTime: string;
  scanTime: Date;
};

export type RoomScanValidationResult = {
  valid: boolean;
  alertType: 'teacher_qr_mismatch' | 'teacher_qr_scan_out_of_time' | null;
};

// Africa/Abidjan is UTC+0 year-round (no DST), so storing/comparing timestamps as UTC
// is correct today. If this product ever serves schools in a non-UTC+0 timezone,
// time comparisons here (late_minutes, QR window) will silently produce wrong results.
const toUtcDateTime = (date: string, time: string): Date => {
  return new Date(`${date}T${time}.000Z`);
};

export const calculateAttendanceStatus = (
  checkedInAt: Date | null,
  slotStart: Date,
  slotEnd: Date
): AttendanceStatusResult => {
  if (!checkedInAt || checkedInAt > slotEnd) {
    return { status: 'absent', lateMinutes: null };
  }

  const diffMinutes = Math.floor((checkedInAt.getTime() - slotStart.getTime()) / 60000);

  if (diffMinutes <= 15) {
    return { status: 'present', lateMinutes: Math.max(0, diffMinutes) };
  }

  return { status: 'late', lateMinutes: diffMinutes };
};

export const validateRoomScan = (
  input: RoomScanValidationInput
): RoomScanValidationResult => {
  const slotStart = toUtcDateTime(input.scheduleDate, input.slotStartTime);
  const slotEnd = toUtcDateTime(input.scheduleDate, input.slotEndTime);
  const windowOpen = new Date(slotStart.getTime() - 10 * 60000);

  if (input.scanTime < windowOpen || input.scanTime > slotEnd) {
    return { valid: false, alertType: 'teacher_qr_scan_out_of_time' };
  }

  if (input.scannedRoomToken !== input.expectedRoomToken) {
    return { valid: false, alertType: 'teacher_qr_mismatch' };
  }

  return { valid: true, alertType: null };
};
