ALTER TABLE public.payment_events
  ADD COLUMN IF NOT EXISTS period_from date,
  ADD COLUMN IF NOT EXISTS period_to   date;
