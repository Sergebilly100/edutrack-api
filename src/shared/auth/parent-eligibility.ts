import { sql } from 'drizzle-orm';

import { confirmedSchoolStudent } from '../database/confirmed-school-membership.js';
import { getRowsUntyped } from '../utils/db-helpers.js';
import { todayInBusinessTimezone } from '../utils/business-time.js';

type QueryExecutor = {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
};

export type ParentPortalMode = {
  isEnabled: boolean;
  monetizeParentAlerts: boolean;
};

export type ParentSubscriptionEligibility = {
  status: string | null;
  startsAt: string | null;
  endsAt: string | null;
};

export class ParentPortalAccessDeniedError extends Error {
  readonly statusCode = 403;
  readonly code = 'PARENT_PORTAL_ACCESS_DENIED';

  constructor() {
    super('Parent portal access denied');
    this.name = 'ParentPortalAccessDeniedError';
  }
}

export const isFreeParentPortalEnabled = (mode: ParentPortalMode): boolean =>
  mode.isEnabled && !mode.monetizeParentAlerts;

export const isParentStudentEligible = (
  mode: ParentPortalMode,
  subscription: ParentSubscriptionEligibility,
  today = todayInBusinessTimezone()
): boolean => {
  if (!mode.isEnabled) return false;
  if (!mode.monetizeParentAlerts) return true;
  return (
    subscription.status === 'active' &&
    subscription.startsAt !== null &&
    subscription.startsAt <= today &&
    subscription.endsAt !== null &&
    subscription.endsAt >= today
  );
};

export const getParentPortalMode = async (db: QueryExecutor): Promise<ParentPortalMode> => {
  const result = await db.execute(sql`
    SELECT
      COALESCE(feature.is_enabled, false) AS is_enabled,
      COALESCE(feature.monetize_parent_alerts, false) AS monetize_parent_alerts
    FROM public.tenants tenant
    LEFT JOIN public.school_sms_features feature ON feature.tenant_id = tenant.id
    WHERE tenant.schema_name = current_schema()
    LIMIT 1
  `);
  const row = getRowsUntyped<{
    is_enabled: boolean;
    monetize_parent_alerts: boolean;
  }>(result)[0];

  return {
    isEnabled: row?.is_enabled ?? false,
    monetizeParentAlerts: row?.monetize_parent_alerts ?? false,
  };
};

export const listEligibleParentStudentIds = async (
  db: QueryExecutor,
  parentId: string
): Promise<string[]> => {
  const mode = await getParentPortalMode(db);
  if (!mode.isEnabled) return [];

  const today = todayInBusinessTimezone();
  const result = await db.execute(sql`
    SELECT DISTINCT
      s.id::text AS student_id,
      ps.status::text AS subscription_status,
      ps.starts_at::text AS subscription_starts_at,
      ps.ends_at::text AS subscription_ends_at,
      (p.phone = s.parent_phone) AS is_primary_contact
    FROM parents p
    INNER JOIN parent_student_links psl ON psl.parent_id = p.id
    INNER JOIN students s ON s.id = psl.student_id
    INNER JOIN classes c ON ${confirmedSchoolStudent(sql`s.id`, sql`c.school_year_id`, sql`c.id`)}
    INNER JOIN school_years sy ON sy.id = c.school_year_id AND sy.status = 'active'
    LEFT JOIN parent_subscriptions ps
      ON ps.id = psl.subscription_id
      AND ps.parent_id = p.id
    WHERE p.id = ${parentId}::uuid
      AND p.is_active = true
      AND s.is_active = true
      AND s.lifecycle_status = 'active'
  `);

  return getRowsUntyped<{
    student_id: string;
    subscription_status: string | null;
    subscription_starts_at: string | null;
    subscription_ends_at: string | null;
    is_primary_contact: boolean;
  }>(result)
    // Mode gratuit : seul le parent principal (contact 1) accède au portail.
    // Mode payant : un abonnement actif suffit, quel que soit le parent.
    .filter((row) => mode.monetizeParentAlerts || row.is_primary_contact)
    .filter((row) =>
      isParentStudentEligible(
        mode,
        {
          status: row.subscription_status,
          startsAt: row.subscription_starts_at,
          endsAt: row.subscription_ends_at,
        },
        today
      )
    )
    .map((row) => row.student_id);
};
