import type { AttendanceStatus } from '../types/index.js';
import { ATTENDANCE_STATUS, NOTIFICATION_TYPE } from '../constants/index.js';

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

export type RoomScanAlertType =
  | typeof NOTIFICATION_TYPE.TEACHER_QR_MISMATCH
  | typeof NOTIFICATION_TYPE.TEACHER_QR_SCAN_OUT_OF_TIME;

export type RoomScanValidationResult = {
  valid: boolean;
  alertType: RoomScanAlertType | null;
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
    return { status: ATTENDANCE_STATUS.ABSENT, lateMinutes: null };
  }

  const diffMinutes = Math.floor((checkedInAt.getTime() - slotStart.getTime()) / 60000);

  if (diffMinutes <= 15) {
    return { status: ATTENDANCE_STATUS.PRESENT, lateMinutes: Math.max(0, diffMinutes) };
  }

  return { status: ATTENDANCE_STATUS.LATE, lateMinutes: diffMinutes };
};

export const validateRoomScan = (
  input: RoomScanValidationInput
): RoomScanValidationResult => {
  const slotStart = toUtcDateTime(input.scheduleDate, input.slotStartTime);
  const slotEnd = toUtcDateTime(input.scheduleDate, input.slotEndTime);
  const windowOpen = new Date(slotStart.getTime() - 10 * 60000);

  if (input.scanTime < windowOpen || input.scanTime > slotEnd) {
    return { valid: false, alertType: NOTIFICATION_TYPE.TEACHER_QR_SCAN_OUT_OF_TIME };
  }

  if (input.scannedRoomToken !== input.expectedRoomToken) {
    return { valid: false, alertType: NOTIFICATION_TYPE.TEACHER_QR_MISMATCH };
  }

  return { valid: true, alertType: null };
};
