DO $$ BEGIN
  CREATE TYPE "tenant"."dashboard_action_priority" AS ENUM ('low', 'medium', 'high');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tenant"."dashboard_action_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "type" varchar(40) NOT NULL,
  "reference_id" uuid,
  "priority" "tenant"."dashboard_action_priority" NOT NULL DEFAULT 'medium',
  "message" text,
  "generated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone,
  "resolved_by_user_id" uuid REFERENCES "tenant"."users"("id")
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "dashboard_action_items_type_ref_unique"
  ON "tenant"."dashboard_action_items" ("type", COALESCE("reference_id"::text, 'global'));--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_dashboard_action_items_open"
  ON "tenant"."dashboard_action_items" ("resolved_at", "priority");--> statement-breakpoint
