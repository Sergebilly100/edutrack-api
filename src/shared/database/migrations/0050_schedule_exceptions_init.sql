-- Le portail parent lit directement l'EDT sans passer par l'initialisation
-- paresseuse du module schedule. Cette table, deja declaree dans le schema
-- Drizzle, doit donc exister des le provisionnement du tenant.
CREATE TABLE IF NOT EXISTS "tenant"."schedule_exceptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "schedule_id" uuid NOT NULL
    REFERENCES "tenant"."schedules"("id") ON DELETE CASCADE,
  "exception_date" date NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "schedule_exceptions_schedule_date_unique"
  ON "tenant"."schedule_exceptions" ("schedule_id", "exception_date");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_schedule_exceptions_schedule"
  ON "tenant"."schedule_exceptions" ("schedule_id");
