ALTER TABLE "tenant"."school_years"
  ADD COLUMN IF NOT EXISTS grading_period_type "tenant".grading_period_type NOT NULL DEFAULT 'trimester';
