CREATE UNIQUE INDEX IF NOT EXISTS "students_matricule_normalized_unique" ON "tenant"."students" USING btree (lower(btrim("matricule")));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "teachers_matricule_normalized_unique" ON "tenant"."teachers" USING btree (lower(btrim("matricule")));
