import { beforeAll, describe, expect, it } from 'vitest';

import { getSeedContext, queryPublic, queryTenant, tenantTable, TEST_SCHEMA_NAME } from './setup.js';

type TenantRow = { id: string };
type IdRow = { id: string };

describe('subscriptions business constraints integration', () => {
  let tenantId = '';
  let parentId = '';
  let studentId = '';

  beforeAll(async () => {
    const tenantRows = await queryPublic<TenantRow>(
      `
        INSERT INTO public.tenants (name, subdomain, schema_name, plan, status, max_users, onboarding_completed)
        VALUES ($1, $2, $3, 'pro', 'active', 50, true)
        ON CONFLICT (schema_name)
        DO UPDATE SET updated_at = NOW()
        RETURNING id::text
      `,
      ['Integration Constraints School', `integration-constraints-${Date.now()}`, TEST_SCHEMA_NAME]
    );
    tenantId = tenantRows[0]!.id;

    await queryPublic(
      `
        INSERT INTO public.school_sms_features (tenant_id, is_enabled, commission_pct, sms_cap_per_student, sms_unit_price_fcfa)
        VALUES ($1::uuid, true, 15.00, 60, 1000)
        ON CONFLICT (tenant_id)
        DO UPDATE SET is_enabled = EXCLUDED.is_enabled, commission_pct = EXCLUDED.commission_pct
      `,
      [tenantId]
    );

    const studentRows = await queryTenant<IdRow>(
      `
        INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, parent_phone, is_active)
        VALUES ((SELECT id FROM ${tenantTable('classes')} LIMIT 1), 'Constraint', 'Student', '2250701110000', true)
        RETURNING id::text
      `
    );
    studentId = studentRows[0]!.id;

    const parentRows = await queryTenant<IdRow>(
      `
        INSERT INTO ${tenantTable('parents')} (full_name, phone, password_hash, must_change_password, is_active)
        VALUES ('Constraint Parent', '2250701111111', 'hash', false, true)
        RETURNING id::text
      `
    );
    parentId = parentRows[0]!.id;
  });

  it('rejette les montants négatifs via contraintes CHECK', async () => {
    await expect(
      queryTenant(
        `
          INSERT INTO ${tenantTable('parent_subscriptions')} (
            parent_id, unit_price_fcfa, student_count, total_amount_fcfa, duration_months,
            starts_at, ends_at, status, auto_renew_alert, renewed_count, created_by
          )
          VALUES ($1::uuid, -1000, 1, -1000, 1, CURRENT_DATE, CURRENT_DATE + INTERVAL '30 day', 'active', false, 0, $2::uuid)
        `,
        [parentId, getSeedContext().directorUserId]
      )
    ).rejects.toThrow();

    await expect(
      queryPublic(
        `
          UPDATE public.school_sms_features
          SET commission_pct = -1
          WHERE tenant_id = $1::uuid
        `,
        [tenantId]
      )
    ).rejects.toThrow();
  });

  it('interdit les chevauchements actifs parent/élève', async () => {
    const context = getSeedContext();

    const subA = await queryTenant<IdRow>(
      `
        INSERT INTO ${tenantTable('parent_subscriptions')} (
          parent_id, unit_price_fcfa, student_count, total_amount_fcfa, duration_months,
          starts_at, ends_at, status, auto_renew_alert, renewed_count, created_by
        )
        VALUES ($1::uuid, 1000, 1, 1000, 1, '2026-04-01', '2026-04-30', 'active', false, 0, $2::uuid)
        RETURNING id::text AS id
      `,
      [parentId, context.directorUserId]
    );

    await queryTenant(
      `
        INSERT INTO ${tenantTable('parent_student_links')} (subscription_id, parent_id, student_id)
        VALUES ($1::uuid, $2::uuid, $3::uuid)
      `,
      [subA[0]!.id, parentId, studentId]
    );

    const subB = await queryTenant<IdRow>(
      `
        INSERT INTO ${tenantTable('parent_subscriptions')} (
          parent_id, unit_price_fcfa, student_count, total_amount_fcfa, duration_months,
          starts_at, ends_at, status, auto_renew_alert, renewed_count, created_by
        )
        VALUES ($1::uuid, 1000, 1, 1000, 1, '2026-04-15', '2026-05-15', 'active', false, 0, $2::uuid)
        RETURNING id::text AS id
      `,
      [parentId, context.directorUserId]
    );

    await expect(
      queryTenant(
        `
          INSERT INTO ${tenantTable('parent_student_links')} (subscription_id, parent_id, student_id)
          VALUES ($1::uuid, $2::uuid, $3::uuid)
        `,
        [subB[0]!.id, parentId, studentId]
      )
    ).rejects.toThrow();
  });
});
