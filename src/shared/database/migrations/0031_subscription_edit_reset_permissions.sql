-- Split parent subscription contact/password actions into dedicated permissions.
-- Existing positions with subscriptions.create already had access to these actions,
-- so keep that behavior until admins choose to refine the role.
UPDATE admin_positions
SET permissions = (
  SELECT jsonb_agg(DISTINCT elem ORDER BY elem)
  FROM jsonb_array_elements_text(
    permissions || '["subscriptions.edit","subscriptions.password.reset"]'::jsonb
  ) AS elem
)
WHERE permissions @> '["subscriptions.create"]'::jsonb
  AND NOT permissions @> '["subscriptions.edit","subscriptions.password.reset"]'::jsonb;
