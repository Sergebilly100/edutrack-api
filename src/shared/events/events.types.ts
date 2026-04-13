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
  studentFirstName: string;
  parentPhone: string;
  subject: string;
  date: string;
  schoolPhone: string;
};

export type SubscriptionExpiredPayload = {
  tenantId: string;
  directorPhone: string;
};

export type EventMap = {
  'teacher.checked_in': TeacherCheckedInPayload;
  'teacher.absent': TeacherAbsentPayload;
  'teacher.*': TeacherCheckedInPayload | TeacherAbsentPayload;
  'student.absent': StudentAbsentPayload;
  'subscription.expired': SubscriptionExpiredPayload;
};

/**
 * Sous-ensemble de EventMap excluant les patterns wildcard.
 * Seuls ces events peuvent être passés à emit().
 */
export type EmittableEventMap = Omit<EventMap, 'teacher.*'>;
