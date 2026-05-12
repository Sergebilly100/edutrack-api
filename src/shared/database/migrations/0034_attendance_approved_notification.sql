ALTER TYPE "tenant"."notification_type" ADD VALUE IF NOT EXISTS 'attendance_approved';
ALTER TYPE "tenant"."notification_type" ADD VALUE IF NOT EXISTS 'scan_end_sanction';
ALTER TYPE "tenant"."notification_type" ADD VALUE IF NOT EXISTS 'scan_end_sanction_cancelled';
