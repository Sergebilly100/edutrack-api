ALTER TABLE public.tenants
ADD COLUMN IF NOT EXISTS allow_teacher_qr_skip boolean NOT NULL DEFAULT false;
