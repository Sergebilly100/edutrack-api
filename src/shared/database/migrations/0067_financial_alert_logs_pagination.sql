CREATE INDEX IF NOT EXISTS "idx_financial_alert_logs_sent_at"
  ON "tenant"."financial_alert_logs" ("sent_at" DESC, "id" DESC);
