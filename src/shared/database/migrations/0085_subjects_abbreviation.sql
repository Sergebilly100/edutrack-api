ALTER TABLE "tenant"."subjects"
  ADD COLUMN IF NOT EXISTS "abbreviation" varchar(30);
