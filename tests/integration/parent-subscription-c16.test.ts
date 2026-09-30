import argon2 from 'argon2';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  getSeedContext,
  queryPublic,
  queryTenant,
  request,
  tenantTable,
  TEST_SCHEMA_NAME,
} from './setup.js';

type IdRow = { id: string };
type ParentCase = { phone: string; studentId: string; token: string };

const password = 'ParentC16!2026';
const price = 1250;
const parents: Record<'active' | 'near' | 'absent', ParentCase> = {
  active: { phone: '2250000008841', studentId: '', token: '' },
  near: { phone: '2250000008842', studentId: '', token: '' },
  absent: { phone: '2250000008843', studentId: '', token: '' },
};

const setOffer = async (enabled: boolean, monetized: boolean, unitPrice: number | null) => {
  await queryPublic(
    `UPDATE public.school_sms_features
     SET is_enabled = $1, monetize_parent_alerts = $2, sms_unit_price_fcfa = $3
     WHERE tenant_id = (SELECT id FROM public.tenants WHERE schema_name = $4)`,
    [enabled, monetized, unitPrice, TEST_SCHEMA_NAME]
  );
};

const statusFor = (parent: ParentCase) => request()
  .get('/api/v1/parent/subscription/status')
  .set('authorization', `Bearer ${parent.token}`);

describe('C16 — statut abonnement parent sur API et base réelles', () => {
  beforeAll(async () => {
    const tenant = await queryPublic<IdRow>(
      `INSERT INTO public.tenants (name, subdomain, schema_name, plan, status, max_users, onboarding_completed)
       VALUES ('École C16', $1, $2, 'pro', 'active', 50, true)
       RETURNING id::text`,
      [`c16-${TEST_SCHEMA_NAME}`, TEST_SCHEMA_NAME]
    );
    await queryPublic(
      `INSERT INTO public.school_sms_features
         (tenant_id, is_enabled, monetize_parent_alerts, sms_unit_price_fcfa)
       VALUES ($1::uuid, true, true, $2)`,
      [tenant[0]!.id, price]
    );

    const context = getSeedContext();
    const klass = await queryTenant<IdRow>(`SELECT id::text FROM ${tenantTable('classes')} LIMIT 1`);
    const yearId = (await queryTenant<IdRow>(`INSERT INTO ${tenantTable('school_years')}
      (label,start_date,end_date,status) VALUES ('C16 parent','2026-09-01','2027-06-30','active') RETURNING id::text`))[0]!.id;
    await queryTenant(`UPDATE ${tenantTable('classes')} SET school_year_id=$1::uuid WHERE id=$2::uuid`, [yearId, klass[0]!.id]);
    const hash = await argon2.hash(password);
    for (const [state, parent] of Object.entries(parents) as Array<[keyof typeof parents, ParentCase]>) {
      const student = await queryTenant<IdRow>(
        `INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, is_active)
         VALUES ($1::uuid, $2, 'C16', true) RETURNING id::text`,
        [klass[0]!.id, state]
      );
      parent.studentId = student[0]!.id;
      await queryTenant(`INSERT INTO ${tenantTable('enrollments')} (student_id,class_id,school_year_id,type,status)
        VALUES ($1::uuid,$2::uuid,$3::uuid,'new_registration','confirmed')`, [parent.studentId, klass[0]!.id, yearId]);
      const parentRows = await queryTenant<IdRow>(
        `INSERT INTO ${tenantTable('parents')}
           (full_name, phone, password_hash, must_change_password, is_active)
         VALUES ($1, $2, $3, false, true) RETURNING id::text`,
        [`Parent C16 ${state}`, parent.phone, hash]
      );
      const parentId = parentRows[0]!.id;
      let subscriptionId: string | null = null;
      if (state !== 'absent') {
        const days = state === 'near' ? 5 : 45;
        const subscriptions = await queryTenant<IdRow>(
          `INSERT INTO ${tenantTable('parent_subscriptions')}
             (parent_id, unit_price_fcfa, student_count, total_amount_fcfa, duration_months,
              starts_at, ends_at, status, created_by)
           VALUES ($1::uuid, $2, 1, $2, 1, CURRENT_DATE - INTERVAL '1 day',
                   CURRENT_DATE + $3::int, 'active', $4::uuid)
           RETURNING id::text`,
          [parentId, price, days, context.directorUserId]
        );
        subscriptionId = subscriptions[0]!.id;
      }
      await queryTenant(
        `INSERT INTO ${tenantTable('parent_student_links')} (parent_id, student_id, subscription_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid)`,
        [parentId, parent.studentId, subscriptionId]
      );
      const login = await request().post('/api/v1/auth/login/parent')
        .set('x-tenant-schema', TEST_SCHEMA_NAME)
        .send({ phone: parent.phone, password });
      expect(login.status).toBe(200);
      parent.token = login.body.accessToken;
    }
  });

  it('conserve le contrat exact pour actif, proche expiration et absent avec offre', async () => {
    for (const state of ['active', 'near', 'absent'] as const) {
      const response = await statusFor(parents[state]);
      expect(response.status).toBe(200);
      expect(response.body.offer).toEqual({
        available: true, unit_price_fcfa: price, billing: 'per_child_per_month',
      });
      if (state === 'absent') {
        expect(response.body).toEqual({ subscription: null, offer: response.body.offer });
      } else {
        expect(response.body.subscription).toEqual({
          status: 'active',
          starts_at: expect.any(String),
          ends_at: expect.any(String),
          days_remaining: expect.any(Number),
          student_count: 1,
          monthly_amount_fcfa: price,
          total_amount_fcfa: price,
          duration_months: 1,
          auto_renew_alert: false,
        });
        expect(response.body.subscription.days_remaining).toBeLessThanOrEqual(state === 'near' ? 5 : 45);
        expect(response.body.subscription.days_remaining).toBeGreaterThan(state === 'near' ? 0 : 30);
      }
    }
  });

  it('cache le prix si le SMS est désactivé, non monétisé ou sans tarif', async () => {
    try {
      for (const [enabled, monetized, unitPrice] of [
        [false, true, price],
        [true, false, price],
        [true, true, null],
        [true, true, 0],
      ] as const) {
        await setOffer(enabled, monetized, unitPrice);
        const response = await statusFor(parents.absent);
        expect(response.status).toBe(200);
        expect(response.body).toEqual({
          subscription: null,
          offer: { available: false, unit_price_fcfa: null, billing: 'per_child_per_month' },
        });
      }
    } finally {
      await setOffer(true, true, price);
    }
  });

  it('garde le contrat EDT indépendant et interdit les enfants des autres parents', async () => {
    const currentWeek = (() => {
      const date = new Date();
      const day = date.getUTCDay() || 7;
      date.setUTCDate(date.getUTCDate() + 4 - day);
      const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
      const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
      return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
    })();
    const own = await request()
      .get(`/api/v1/parent/students/${parents.absent.studentId}/schedule?week=${currentWeek}`)
      .set('authorization', `Bearer ${parents.absent.token}`);
    expect(own.status).toBe(200);
    expect(own.body).toEqual({ week_label: currentWeek, days: expect.any(Array) });
    expect(own.body).not.toHaveProperty('subscription');
    expect(own.body).not.toHaveProperty('offer');

    for (const route of ['schedule?week=' + currentWeek, 'stats', 'absences?month=2026-09']) {
      const denied = await request()
        .get(`/api/v1/parent/students/${parents.active.studentId}/${route}`)
        .set('authorization', `Bearer ${parents.absent.token}`);
      expect(denied.status).toBe(403);
      expect(denied.body).toEqual({
        error: expect.any(String), code: 'STUDENT_ACCESS_DENIED', statusCode: 403,
      });
    }
    const ownStudents = await request().get('/api/v1/parent/students')
      .set('authorization', `Bearer ${parents.absent.token}`);
    expect(ownStudents.status).toBe(200);
    expect(ownStudents.body.data.map((student: { id: string }) => student.id))
      .toEqual([parents.absent.studentId]);
  });
});
