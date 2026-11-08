-- Image unique « cachet et signature du chef de l'établissement » + métadonnées du logo.
-- Colonnes sur public.tenants (même modèle que logo_url / stamp_image_url).
-- Les objets seal_*_key sont des clés R2 PRIVÉES (jamais d'URL publique), servies via l'API authentifiée.
-- Idempotent : ADD COLUMN IF NOT EXISTS, sans valeur par défaut coûteuse (pas de réécriture de table).
-- Retour arrière : voir archives/ivoiredu-v2/taches/fix/rollback-0100-school-seal-image.md
ALTER TABLE "public"."tenants"
  ADD COLUMN IF NOT EXISTS "seal_original_key" text,
  ADD COLUMN IF NOT EXISTS "seal_processed_key" text,
  ADD COLUMN IF NOT EXISTS "seal_file_name" varchar(255),
  ADD COLUMN IF NOT EXISTS "seal_mime" varchar(50),
  ADD COLUMN IF NOT EXISTS "seal_size_bytes" integer,
  ADD COLUMN IF NOT EXISTS "seal_width" integer,
  ADD COLUMN IF NOT EXISTS "seal_height" integer,
  ADD COLUMN IF NOT EXISTS "seal_remove_white" boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS "seal_updated_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "logo_file_name" varchar(255),
  ADD COLUMN IF NOT EXISTS "logo_mime" varchar(50),
  ADD COLUMN IF NOT EXISTS "logo_size_bytes" integer,
  ADD COLUMN IF NOT EXISTS "logo_width" integer,
  ADD COLUMN IF NOT EXISTS "logo_height" integer,
  ADD COLUMN IF NOT EXISTS "logo_updated_at" timestamp with time zone;
