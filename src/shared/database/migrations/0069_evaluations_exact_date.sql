ALTER TABLE "tenant"."evaluations"
  ADD COLUMN IF NOT EXISTS "evaluation_date" date;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_evaluations_exact_date"
  ON "tenant"."evaluations" ("evaluation_date");
