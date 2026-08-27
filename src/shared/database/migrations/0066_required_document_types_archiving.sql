ALTER TABLE "tenant"."required_document_types"
  ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_required_document_types_level_active"
  ON "tenant"."required_document_types" ("level_id", "is_active");
