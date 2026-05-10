-- Migration 0030: grant students.excuse to positions that already have students.edit
-- Directors already get all permissions via code (baseRolePermissions). This migration
-- ensures that staff positions with students.edit authority can also excuse absences.

UPDATE "tenant"."admin_positions"
SET permissions = (
  SELECT jsonb_agg(DISTINCT elem ORDER BY elem)
  FROM jsonb_array_elements_text(permissions || '["students.excuse"]'::jsonb) AS elem
)
WHERE permissions @> '["students.edit"]'::jsonb
  AND NOT permissions @> '["students.excuse"]'::jsonb;
