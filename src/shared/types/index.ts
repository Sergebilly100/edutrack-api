export type CheckedInVia = 'app' | 'manual' | 'secretary';

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

export type AttendanceStatus = 'present' | 'absent' | 'late' | 'excused';

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
  | 'student_absent_parent'
  | 'payment_reminder'
  | 'custom';
