CREATE TABLE IF NOT EXISTS "public"."audit_financial_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "public"."tenants"("id") ON DELETE CASCADE,
  "actor_id" uuid,
  "actor_role" varchar(50) NOT NULL,
  "action" varchar(100) NOT NULL,
  "idempotency_key" uuid,
  "payload_before" jsonb,
  "payload_after" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_financial_events_tenant_created_at"
ON "public"."audit_financial_events" USING btree ("tenant_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "audit_financial_events_action_tenant_key_unique"
ON "public"."audit_financial_events" USING btree ("action", "tenant_id", "idempotency_key")
WHERE "idempotency_key" IS NOT NULL;
