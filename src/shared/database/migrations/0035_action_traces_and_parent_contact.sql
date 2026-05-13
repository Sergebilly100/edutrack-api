ALTER TABLE "tenant"."import_history"
  ADD COLUMN IF NOT EXISTS "imported_by" uuid REFERENCES "tenant"."users"("id"),
  ADD COLUMN IF NOT EXISTS "imported_by_role" varchar(100);

CREATE INDEX IF NOT EXISTS "idx_import_history_imported_by"
ON "tenant"."import_history" USING btree ("imported_by");
