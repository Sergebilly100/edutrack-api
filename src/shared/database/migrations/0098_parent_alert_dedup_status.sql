ALTER TYPE "tenant".notification_status
  ADD VALUE IF NOT EXISTS 'skipped_duplicate';
