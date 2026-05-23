export type CheckedInVia = 'app' | 'manual' | 'secretary' | 'staff';

export type QRScanType = 'start' | 'end';

export type QRScanPayload = {
  qr_token: string;
  scan_type: QRScanType;
  schedule_id: string;
  // scanned_at intentionally omitted — timestamp generated server-side only
};

export type SchedulePeriod = {
  id: string;
  name: string;
  valid_from: string;
  valid_to: string;
  is_active: boolean;
};

export type Room = {
  id: string;
  name: string;
  qr_token: string;
  building?: string;
  is_active: boolean;
};

export type AttendanceStatus = 'present' | 'absent' | 'late';

export type AttendanceRecord = {
  id: string;
  teacher_id: string;
  schedule_id: string | null;
  date: string; // ISO 8601 date string (YYYY-MM-DD)
  status: AttendanceStatus;
  checked_in_at: string | null; // ISO 8601 datetime (UTC)
  checked_in_via: CheckedInVia | null; // null = pointage automatique app
  late_minutes: number | null; // null si absent, 0 si à l'heure, >0 si retard
  room_scanned_id: string | null; // UUID de la salle scannée
  room_scanned_name?: string; // dénormalisé pour affichage direct
  room_scan_start_at: string | null; // ISO 8601 datetime (UTC)
  room_scan_end_at: string | null; // ISO 8601 datetime (UTC), optionnel
  room_mismatch: boolean;
  synced_at: string | null; // null = en attente de sync offline
};

export type CheckInPayload = {
  teacherId: string;
  scheduleId: string;
  date: string;
};

export type NotificationType =
  | 'teacher_absent_director'
  | 'teacher_late_director'
  | 'teacher_qr_mismatch'
  | 'teacher_qr_missing_scan'
  | 'teacher_qr_scan_out_of_time'
  | 'qr_invalid_alert'
  | 'student_absent_parent'
  | 'attendance_rejected'
  | 'attendance_approved'
  | 'scan_end_warning'
  | 'scan_end_sanction'
  | 'scan_end_sanction_cancelled'
  | 'subscription_expiry_alert'
  | 'payment_reminder'
  | 'custom';

export type PermissionKey =
  | 'teachers.view'
  | 'teachers.create'
  | 'teachers.edit'
  | 'teachers.block'
  | 'teachers.documents'
  | 'students.view'
  | 'students.create'
  | 'students.edit'
  | 'students.documents'
  | 'students.excuse'
  | 'schedule.view'
  | 'schedule.edit'
  | 'attendance.view'
  | 'attendance.mark_students'
  | 'salary.view'
  | 'salary.compute'
  | 'salary.mark_paid'
  | 'salary.export'
  | 'validations.view'
  | 'validations.approve'
  | 'validations.reject'
  | 'rooms.view'
  | 'rooms.create'
  | 'rooms.edit'
  | 'rooms.delete'
  | 'import.students'
  | 'import.teachers'
  | 'import.schedule'
  | 'settings.positions'
  | 'settings.school'
  | 'settings.sms_templates'
  | 'subscriptions.view'
  | 'subscriptions.create'
  | 'subscriptions.renew'
  | 'subscriptions.cancel'
  | 'subscriptions.revenue';
