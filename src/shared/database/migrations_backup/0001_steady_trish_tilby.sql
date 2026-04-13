ALTER TABLE "admin_access_log" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_access_log" ALTER COLUMN "ip_address" SET DATA TYPE "undefined"."inet";--> statement-breakpoint
ALTER TABLE "subscriptions" ALTER COLUMN "current_period_start" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ALTER COLUMN "current_period_end" SET NOT NULL;