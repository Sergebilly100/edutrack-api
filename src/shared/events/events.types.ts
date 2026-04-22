import type { CheckedInVia } from '../types/index.js';

export type TeacherCheckedInPayload = {
  tenantId: string;
  schemaName: string;
  teacherId: string;
  scheduleId?: string;
  date: string;
  checkedInAt: string;
  checkedInVia: CheckedInVia;
};

export type TeacherLatePayload = TeacherCheckedInPayload & {
  lateMinutes: number;
};

export type TeacherQrAlertPayload = {
  tenantId: string;
  schemaName: string;
  teacherId: string;
  scheduleId: string;
  date: string;
  alertType:
    | 'teacher_qr_mismatch'
    | 'teacher_qr_missing_scan'
    | 'teacher_qr_scan_out_of_time';
  roomMismatch: boolean;
};

export type TeacherAbsentPayload = {
  tenantId: string;
  schemaName: string;
  teacherId: string;
  teacherName: string;
  subject: string;
  className: string;
  slotLabel: string;
  directorPhone: string;
};

export type StudentAbsentPayload = {
  tenantId: string;
  schemaName: string;
  studentId: string;
  scheduleId: string;
  studentFirstName: string;
  parentPhone: string;
  subject: string;
  date: string;
  schoolPhone: string;
};

export type SubscriptionExpiredPayload = {
  tenantId: string;
  schemaName: string;
  schoolName: string;
  periodLabel: string;
  dueDate: string;
  remainingAmountFcfa: number;
  directorPhone: string;
};

export type EventMap = {
  'teacher.checked_in': TeacherCheckedInPayload;
  'teacher.late': TeacherLatePayload;
  'teacher.qr_alert': TeacherQrAlertPayload;
  'teacher.absent': TeacherAbsentPayload;
  'teacher.*':
    | TeacherCheckedInPayload
    | TeacherLatePayload
    | TeacherQrAlertPayload
    | TeacherAbsentPayload;
  'student.absent': StudentAbsentPayload;
  'subscription.expired': SubscriptionExpiredPayload;
};

/**
 * Sous-ensemble de EventMap excluant les patterns wildcard.
 * Seuls ces events peuvent être passés à emit().
 */
export type EmittableEventMap = Omit<EventMap, 'teacher.*'>;
