export const ATTENDANCE_STATUS = {
  PRESENT: 'present',
  ABSENT: 'absent',
  LATE: 'late',
  EXCUSED: 'excused',
} as const;
export type AttendanceStatusValue =
  (typeof ATTENDANCE_STATUS)[keyof typeof ATTENDANCE_STATUS];

export const SUBSCRIPTION_STATUS = {
  TRIAL: 'trial',
  ACTIVE: 'active',
  PAST_DUE: 'past_due',
  CANCELED: 'canceled',
  SUSPENDED: 'suspended',
} as const;
export type SubscriptionStatusValue =
  (typeof SUBSCRIPTION_STATUS)[keyof typeof SUBSCRIPTION_STATUS];

export const VALIDATION_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
} as const;
export type ValidationStatusValue =
  (typeof VALIDATION_STATUS)[keyof typeof VALIDATION_STATUS];

export const NOTIFICATION_TYPE = {
  TEACHER_ABSENT_DIRECTOR: 'teacher_absent_director',
  TEACHER_LATE_DIRECTOR: 'teacher_late_director',
  TEACHER_QR_MISMATCH: 'teacher_qr_mismatch',
  TEACHER_QR_MISSING_SCAN: 'teacher_qr_missing_scan',
  TEACHER_QR_SCAN_OUT_OF_TIME: 'teacher_qr_scan_out_of_time',
  QR_INVALID_ALERT: 'qr_invalid_alert',
  STUDENT_ABSENT_PARENT: 'student_absent_parent',
  ATTENDANCE_REJECTED: 'attendance_rejected',
  ATTENDANCE_APPROVED: 'attendance_approved',
  SCAN_END_WARNING: 'scan_end_warning',
  SCAN_END_SANCTION: 'scan_end_sanction',
  SCAN_END_SANCTION_CANCELLED: 'scan_end_sanction_cancelled',
  SUBSCRIPTION_EXPIRY_ALERT: 'subscription_expiry_alert',
  PAYMENT_REMINDER: 'payment_reminder',
  CUSTOM: 'custom',
} as const;
export type NotificationTypeValue =
  (typeof NOTIFICATION_TYPE)[keyof typeof NOTIFICATION_TYPE];

export const CHECKED_IN_VIA = {
  APP: 'app',
  MANUAL: 'manual',
  SECRETARY: 'secretary',
  STAFF: 'staff',
} as const;
export type CheckedInViaValue =
  (typeof CHECKED_IN_VIA)[keyof typeof CHECKED_IN_VIA];

export const QR_SCAN_TYPE = {
  START: 'start',
  END: 'end',
} as const;
export type QRScanTypeValue = (typeof QR_SCAN_TYPE)[keyof typeof QR_SCAN_TYPE];
