ALTER TABLE "tenant"."notifications_log"
ADD COLUMN IF NOT EXISTS "channel" varchar(10) NOT NULL DEFAULT 'sms';
--> statement-breakpoint
ALTER TABLE "tenant"."notifications_log"
ADD COLUMN IF NOT EXISTS "recipient_email" varchar(255);
--> statement-breakpoint
ALTER TABLE "tenant"."notifications_log"
DROP CONSTRAINT IF EXISTS notifications_log_channel_check;
--> statement-breakpoint
ALTER TABLE "tenant"."notifications_log"
ADD CONSTRAINT notifications_log_channel_check
CHECK ("channel" IN ('sms', 'email'));
