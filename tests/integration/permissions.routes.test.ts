import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSION_KEYS } from '../../src/modules/permissions/permissions.types.js';

const mocks = vi.hoisted(() => ({
  withTenantSchema: vi.fn(),
  verifyAccessToken: vi.fn(),
  dbExecute: vi.fn(),
  getPlanLimitsBySchemaName: vi.fn(),
  argon2Hash: vi.fn(),
}));

vi.mock('../../src/shared/database/db.js', () => ({
  withTenantSchema: mocks.withTenantSchema,
}));

vi.mock('../../src/modules/auth/auth.service.js', async () => {
  const actual = await vi.importActual('../../src/modules/auth/auth.service.js');
  return {
    ...actual,
    verifyAccessToken: mocks.verifyAccessToken,
  };
});

vi.mock('../../src/shared/utils/users-limit.js', () => ({
  getPlanLimitsBySchemaName: mocks.getPlanLimitsBySchemaName,
  buildUsersLimitReachedMessage: (c: number, m: number) => `Limite ${c}/${m}`,
  getMaxUsersBySchemaName: vi.fn(),
}));

vi.mock('argon2', () => ({
  default: { hash: mocks.argon2Hash },
}));

import permissionsController from '../../src/modules/permissions/permissions.controller.js';
import { requirePermission } from '../../src/shared/middleware/auth.middleware.js';

const buildApp = async () => {
  const app = Fastify();
  await app.register(permissionsController);
  app.post('/api/v1/billing/salary/compute', { preHandler: requirePermission('salary.compute') }, async () => {
    return { ok: true };
  });
  await app.ready();
  return app;
};

// ─── UUIDs valides (Zod v4 strict) ──────────────────────────────────────────
const UUID_POSITION_1 = '550e8400-e29b-41d4-a716-446655440001';
const UUID_POSITION_99 = '550e8400-e29b-41d4-a716-446655440099';
const UUID_USER_11 = '550e8400-e29b-41d4-a716-446655440011';
const UUID_USER_20 = '550e8400-e29b-41d4-a716-446655440020';
const UUID_USER_99 = '550e8400-e29b-41d4-a716-446655440099';

// ─── Helpers de token ───────────────────────────────────────────────────────

const makeDirectorToken = () =>
  mocks.verifyAccessToken.mockResolvedValue({
    sub: 'director-user-id',
    role: 'director',
    schemaName: 'school_sainte_marie',
  });

const makeSuperAdminToken = () =>
  mocks.verifyAccessToken.mockResolvedValue({
    sub: 'super-admin-id',
    role: 'super_admin',
    schemaName: 'school_sainte_marie',
  });

// ─── Données de référence ───────────────────────────────────────────────────

const defaultSchoolConfigRow = {
  name: 'Sainte Marie',
  subdomain: 'sainte-marie',
  plan: 'pro',
  city: 'Abidjan',
  teaching_type: 'general',
  max_users: 100,
  max_admin_positions: 10,
  can_edit_sms_template: false,
  allow_teacher_qr_skip: false,
  logo_url: null,
  active_school_year: '2025-2026',
};

const makePosition = (overrides: Record<string, unknown> = {}) => ({
  id: UUID_POSITION_1,
  name: 'Censeur',
  permissions: [],
  created_by: 'director-user-id',
  created_at: new Date().toISOString(),
  assignments_count: 0,
  ...overrides,
});

const makeUser = (overrides: Record<string, unknown> = {}) => ({
  id: UUID_USER_11,
  name: 'Utilisateur Test',
  role: 'staff',
  email: 'test@ecole.ci',
  phone: null,
  ...overrides,
});

// ─── beforeEach ─────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  mocks.argon2Hash.mockResolvedValue('hashed-pw');
  mocks.getPlanLimitsBySchemaName.mockResolvedValue({ max_users: 100, max_admin_positions: 10 });
  mocks.dbExecute.mockResolvedValue({ rows: [] });

  // withTenantSchema appelle la callback avec un db mocké
  // Les deux appels (auth + controller) partagent la même séquence dbExecute
  mocks.withTenantSchema.mockImplementation(
    async (_schema: string, callback: (db: { execute: typeof mocks.dbExecute }) => unknown) => {
      return callback({ execute: mocks.dbExecute });
    }
  );

  // Par défaut : staff sans permission
  mocks.verifyAccessToken.mockResolvedValue({
    sub: 'staff-user-id',
    role: 'staff',
    schemaName: 'school_sainte_marie',
  });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('permissions routes', () => {

  // ── Tests originaux ──────────────────────────────────────────────────────

  it('GET /api/v1/permissions/me ne donne aucune permission implicite au staff sans poste assigné', async () => {
    // staff: auth → getSchoolConfigBySchemaName + listAssignedPermissions (vide)
    mocks.dbExecute
      .mockResolvedValueOnce({ rows: [defaultSchoolConfigRow] }) // getSchoolConfigBySchemaName
      .mockResolvedValueOnce({ rows: [] }); // listAssignedPermissions

    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/permissions/me',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { role: string; permissions: string[] };
    expect(body.role).toBe('staff');
    expect(body.permissions).toEqual([]);

    await app.close();
  });

  it('POST /api/v1/billing/salary/compute refuse un staff (403)', async () => {
    // staff: auth → getSchoolConfig + listAssignedPermissions (vide)
    mocks.dbExecute
      .mockResolvedValueOnce({ rows: [defaultSchoolConfigRow] })
      .mockResolvedValueOnce({ rows: [] });

    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/salary/compute?month=2025-01',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body) as { code: string };
    expect(body.code).toBe('FORBIDDEN');

    await app.close();
  });

  it('POST /api/v1/billing/salary/compute autorise un director', async () => {
    makeDirectorToken();
    // director: auth → getSchoolConfigBySchemaName seulement
    mocks.dbExecute.mockResolvedValueOnce({ rows: [defaultSchoolConfigRow] });

    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/salary/compute?month=2025-01',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });

    await app.close();
  });

  it('GET /api/v1/permissions/me retourne toutes les permissions pour director', async () => {
    makeDirectorToken();
    // director: auth → getSchoolConfigBySchemaName seulement
    mocks.dbExecute.mockResolvedValueOnce({ rows: [defaultSchoolConfigRow] });

    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/permissions/me',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { role: string; permissions: string[] };
    expect(body.role).toBe('director');
    const EXCLUDED_WHEN_NO_MONETIZE = new Set([
      'settings.sms_templates',
      'subscriptions.view',
      'subscriptions.create',
      'subscriptions.renew',
      'subscriptions.cancel',
      'subscriptions.revenue',
    ]);
    expect(new Set(body.permissions)).toEqual(
      new Set(PERMISSION_KEYS.filter((permission) => !EXCLUDED_WHEN_NO_MONETIZE.has(permission)))
    );

    await app.close();
  });

  // ── Cas 4 : GET /config refuse staff sans permission ─────────────────────

  it('GET /api/v1/permissions/config retourne 403 si staff sans permission settings.positions', async () => {
    // staff: auth → getSchoolConfig + listAssignedPermissions (vide)
    mocks.dbExecute
      .mockResolvedValueOnce({ rows: [defaultSchoolConfigRow] })
      .mockResolvedValueOnce({ rows: [] });

    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/permissions/config',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body) as { code: string };
    expect(body.code).toBe('FORBIDDEN');

    await app.close();
  });

  // ── Cas 5 : GET /config retourne 200 si director ─────────────────────────

  it('GET /api/v1/permissions/config retourne 200 si director', async () => {
    makeDirectorToken();

    // Séquence: auth (1 appel) + getConfig (5 appels en Promise.all)
    // withTenantSchema est appelé 2 fois: une fois pour auth, une fois pour le controller.
    // Les deux callbacks partagent le même dbExecute (séquence)
    mocks.dbExecute
      .mockResolvedValueOnce({ rows: [defaultSchoolConfigRow] })  // auth: getSchoolConfigBySchemaName (director)
      .mockResolvedValueOnce({ rows: [defaultSchoolConfigRow] })  // getConfig: getSchoolConfigBySchemaName
      .mockResolvedValueOnce({ rows: [] })                        // getConfig: listPositions
      .mockResolvedValueOnce({ rows: [] })                        // getConfig: listAdministrativeUsers
      .mockResolvedValueOnce({ rows: [{ count: 0 }] })           // getConfig: countActiveUsers
      .mockResolvedValueOnce({ rows: [{ count: 0 }] });          // getConfig: countActiveAdministrativeUsers

    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/permissions/config',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(response.statusCode).toBe(200);

    await app.close();
  });

  // ── Cas 6 : POST /positions crée un poste (201) ───────────────────────────

  it('POST /api/v1/permissions/positions crée un poste (201) si director', async () => {
    makeDirectorToken();

    const newPosition = makePosition({ permissions: ['teachers.view'] });

    mocks.dbExecute
      .mockResolvedValueOnce({ rows: [defaultSchoolConfigRow] }) // auth: getSchoolConfigBySchemaName
      .mockResolvedValueOnce({ rows: [defaultSchoolConfigRow] }) // createPosition: getSchoolConfigBySchemaName
      .mockResolvedValueOnce({ rows: [newPosition] });           // createPosition: INSERT RETURNING

    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/permissions/positions',
      headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Censeur', permissions: ['teachers.view'] }),
    });

    expect(response.statusCode).toBe(201);

    await app.close();
  });

  // ── Cas 7 : POST /positions refuse nom vide (400) ────────────────────────

  it('POST /api/v1/permissions/positions refuse un nom de poste vide (400)', async () => {
    makeDirectorToken();
    mocks.dbExecute.mockResolvedValueOnce({ rows: [defaultSchoolConfigRow] }); // auth

    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/permissions/positions',
      headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
      body: JSON.stringify({ name: '', permissions: [] }),
    });

    expect(response.statusCode).toBe(400);

    await app.close();
  });

  // ── Cas 8 : PUT /positions/:id met à jour un poste (200) ─────────────────

  it('PUT /api/v1/permissions/positions/:id met à jour un poste (200)', async () => {
    makeDirectorToken();

    const updatedPosition = makePosition({ name: 'Censeur modifié' });

    mocks.dbExecute
      .mockResolvedValueOnce({ rows: [defaultSchoolConfigRow] }) // auth
      .mockResolvedValueOnce({ rows: [defaultSchoolConfigRow] }) // updatePosition: getSchoolConfigBySchemaName
      .mockResolvedValueOnce({ rows: [updatedPosition] });       // updatePosition: UPDATE RETURNING

    const app = await buildApp();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/permissions/positions/${UUID_POSITION_1}`,
      headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Censeur modifié' }),
    });

    expect(response.statusCode).toBe(200);

    await app.close();
  });

  // ── Cas 9 : PUT /positions/:id retourne 404 si poste inexistant ───────────

  it('PUT /api/v1/permissions/positions/:id retourne 404 si poste inexistant', async () => {
    makeDirectorToken();

    mocks.dbExecute
      .mockResolvedValueOnce({ rows: [defaultSchoolConfigRow] }) // auth
      .mockResolvedValueOnce({ rows: [defaultSchoolConfigRow] }) // updatePosition: getSchoolConfigBySchemaName
      .mockResolvedValueOnce({ rows: [] });                      // updatePosition: UPDATE RETURNING (rien → not found)

    const app = await buildApp();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/permissions/positions/${UUID_POSITION_99}`,
      headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Inexistant' }),
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body) as { code: string };
    expect(body.code).toBe('POSITION_NOT_FOUND');

    await app.close();
  });

  // ── Cas 10 : DELETE /positions/:id supprime un poste sans assignation (200) ─

  it('DELETE /api/v1/permissions/positions/:id supprime un poste sans assignation (200)', async () => {
    makeDirectorToken();

    mocks.dbExecute
      .mockResolvedValueOnce({ rows: [defaultSchoolConfigRow] })          // auth
      .mockResolvedValueOnce({ rows: [makePosition({ assignments_count: 0 })] }) // deletePosition: findPositionById
      .mockResolvedValueOnce({ rows: [{ id: UUID_POSITION_1 }] });        // deletePosition: DELETE RETURNING

    const app = await buildApp();

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/permissions/positions/${UUID_POSITION_1}`,
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { deleted: boolean };
    expect(body.deleted).toBe(true);

    await app.close();
  });

  // ── Cas 11 : DELETE /positions/:id retourne 409 si poste avec assignations ─

  it('DELETE /api/v1/permissions/positions/:id retourne 409 si poste avec assignations', async () => {
    makeDirectorToken();

    mocks.dbExecute
      .mockResolvedValueOnce({ rows: [defaultSchoolConfigRow] })              // auth
      .mockResolvedValueOnce({ rows: [makePosition({ assignments_count: 2 })] }); // deletePosition: findPositionById

    const app = await buildApp();

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/permissions/positions/${UUID_POSITION_1}`,
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body) as { code: string };
    expect(body.code).toBe('POSITION_HAS_ASSIGNMENTS');

    await app.close();
  });

  // ── Cas 12 : POST /users crée un utilisateur administratif (201) ──────────

  it('POST /api/v1/permissions/users crée un utilisateur administratif (201)', async () => {
    makeDirectorToken();

    const createdUser = makeUser({ name: 'Kouamé Fatou', email: 'fatou@ecole.ci' });

    // createAdministrativeUser: Promise.all([getSchoolConfig, getPlanLimits(externe), countActiveUsers, countActiveAdminUsers])
    // getPlanLimits est mocké directement (pas via dbExecute)
    mocks.dbExecute
      .mockResolvedValueOnce({ rows: [defaultSchoolConfigRow] }) // auth: getSchoolConfigBySchemaName
      .mockResolvedValueOnce({ rows: [defaultSchoolConfigRow] }) // createAdministrativeUser: getSchoolConfigBySchemaName
      .mockResolvedValueOnce({ rows: [{ count: 5 }] })           // createAdministrativeUser: countActiveUsers
      .mockResolvedValueOnce({ rows: [{ count: 2 }] })           // createAdministrativeUser: countActiveAdministrativeUsers
      .mockResolvedValueOnce({ rows: [createdUser] });            // createAdministrativeUser: INSERT RETURNING

    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/permissions/users',
      headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Kouamé Fatou', email: 'fatou@ecole.ci', password: 'Password123!' }),
    });

    expect(response.statusCode).toBe(201);

    await app.close();
  });

  // ── Cas 13 : POST /users retourne 400 si mot de passe trop court ──────────

  it('POST /api/v1/permissions/users retourne 400 si mot de passe trop court', async () => {
    makeDirectorToken();
    mocks.dbExecute.mockResolvedValueOnce({ rows: [defaultSchoolConfigRow] }); // auth

    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/permissions/users',
      headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Test', email: 't@test.ci', password: 'short' }),
    });

    expect(response.statusCode).toBe(400);

    await app.close();
  });

  // ── Cas 14 : POST /users retourne 400 si ni email ni téléphone ───────────

  it('POST /api/v1/permissions/users retourne 400 si ni email ni téléphone fourni', async () => {
    makeDirectorToken();
    mocks.dbExecute.mockResolvedValueOnce({ rows: [defaultSchoolConfigRow] }); // auth

    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/permissions/users',
      headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Test User', password: 'Password123!' }),
    });

    expect(response.statusCode).toBe(400);

    await app.close();
  });

  // ── Cas 15 : DELETE /users/:id désactive un utilisateur (200) ────────────

  it('DELETE /api/v1/permissions/users/:id désactive un utilisateur (200)', async () => {
    makeDirectorToken();

    mocks.dbExecute
      .mockResolvedValueOnce({ rows: [defaultSchoolConfigRow] })      // auth
      .mockResolvedValueOnce({ rows: [makeUser()] })                   // deleteAdministrativeUser: findAdministrativeUserById
      .mockResolvedValueOnce({ rows: [{ id: UUID_USER_11 }] });       // deleteAdministrativeUser: deactivate (WITH ... UPDATE)

    const app = await buildApp();

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/permissions/users/${UUID_USER_11}`,
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { deleted: boolean };
    expect(body.deleted).toBe(true);

    await app.close();
  });

  // ── Cas 16 : DELETE /users/:id retourne 404 si utilisateur introuvable ────

  it('DELETE /api/v1/permissions/users/:id retourne 404 si utilisateur introuvable', async () => {
    makeDirectorToken();

    mocks.dbExecute
      .mockResolvedValueOnce({ rows: [defaultSchoolConfigRow] }) // auth
      .mockResolvedValueOnce({ rows: [] });                      // deleteAdministrativeUser: findAdministrativeUserById → null

    const app = await buildApp();

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/permissions/users/${UUID_USER_99}`,
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(response.statusCode).toBe(404);

    await app.close();
  });

  // ── Cas 17 : POST /users/:id/reset-password réinitialise le mot de passe ──

  it('POST /api/v1/permissions/users/:id/reset-password réinitialise le mot de passe (200)', async () => {
    makeDirectorToken();

    mocks.dbExecute
      .mockResolvedValueOnce({ rows: [defaultSchoolConfigRow] })      // auth
      .mockResolvedValueOnce({ rows: [makeUser()] })                   // resetAdministrativeUserPassword: findAdministrativeUserById
      .mockResolvedValueOnce({ rows: [{ id: UUID_USER_11 }] });       // resetAdministrativeUserPassword: UPDATE password_hash

    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/permissions/users/${UUID_USER_11}/reset-password`,
      headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
      body: JSON.stringify({ newPassword: 'NewPassword123!' }),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { updated: boolean };
    expect(body.updated).toBe(true);

    await app.close();
  });

  // ── Cas 18 : POST /users/:id/reset-password retourne 400 si password < 8 ─

  it('POST /api/v1/permissions/users/:id/reset-password retourne 400 si password < 8 chars', async () => {
    makeDirectorToken();
    mocks.dbExecute.mockResolvedValueOnce({ rows: [defaultSchoolConfigRow] }); // auth

    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/permissions/users/${UUID_USER_11}/reset-password`,
      headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
      body: JSON.stringify({ newPassword: 'short' }),
    });

    expect(response.statusCode).toBe(400);

    await app.close();
  });

  // ── Cas 19 : PATCH /config/limits autorise le super_admin ────────────────

  it('PATCH /api/v1/permissions/config/limits autorise le super_admin à modifier les limites', async () => {
    makeSuperAdminToken();

    // super_admin: resolveEffectivePermissions retourne ALL sans appel DB (pas de getSchoolConfig dans auth)
    // Mais requirePermission('settings.school') → authenticateRequest → withTenantSchema → resolveEffectivePermissions
    // Pour super_admin: retourne directement sans dbExecute
    // Puis controller → withTenantSchema → updateLimits → updateMaxAdminPositions (1) + getConfig (5)
    mocks.dbExecute
      .mockResolvedValueOnce({ rows: [] })                        // updateMaxAdminPositions: UPDATE (void, rows ignoré)
      .mockResolvedValueOnce({ rows: [defaultSchoolConfigRow] }) // getConfig: getSchoolConfigBySchemaName
      .mockResolvedValueOnce({ rows: [] })                        // getConfig: listPositions
      .mockResolvedValueOnce({ rows: [] })                        // getConfig: listAdministrativeUsers
      .mockResolvedValueOnce({ rows: [{ count: 0 }] })           // getConfig: countActiveUsers
      .mockResolvedValueOnce({ rows: [{ count: 0 }] });          // getConfig: countActiveAdministrativeUsers

    const app = await buildApp();

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/permissions/config/limits',
      headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
      body: JSON.stringify({ max_admin_positions: 5 }),
    });

    expect(response.statusCode).toBe(200);

    await app.close();
  });

  // ── Cas 20 : PATCH /config/limits refuse le director (403) ───────────────

  it('PATCH /api/v1/permissions/config/limits refuse le director (403)', async () => {
    makeDirectorToken();

    // director a settings.school → passe requirePermission
    // mais le controller vérifie role !== 'super_admin' → FORBIDDEN
    mocks.dbExecute.mockResolvedValueOnce({ rows: [defaultSchoolConfigRow] }); // auth

    const app = await buildApp();

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/permissions/config/limits',
      headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
      body: JSON.stringify({ max_admin_positions: 5 }),
    });

    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body) as { code: string };
    expect(body.code).toBe('FORBIDDEN');

    await app.close();
  });

  // ── Cas 21 : PATCH /config/school met à jour la config école ────────────

  it('PATCH /api/v1/permissions/config/school met à jour la config école', async () => {
    makeDirectorToken();

    // director auth (1) + updateSchoolConfig: UPDATE (1) + getConfig (5)
    mocks.dbExecute
      .mockResolvedValueOnce({ rows: [defaultSchoolConfigRow] }) // auth: getSchoolConfigBySchemaName
      .mockResolvedValueOnce({ rows: [] })                        // updateSchoolConfig: UPDATE (void)
      .mockResolvedValueOnce({ rows: [defaultSchoolConfigRow] }) // getConfig: getSchoolConfigBySchemaName
      .mockResolvedValueOnce({ rows: [] })                        // getConfig: listPositions
      .mockResolvedValueOnce({ rows: [] })                        // getConfig: listAdministrativeUsers
      .mockResolvedValueOnce({ rows: [{ count: 0 }] })           // getConfig: countActiveUsers
      .mockResolvedValueOnce({ rows: [{ count: 0 }] });          // getConfig: countActiveAdministrativeUsers

    const app = await buildApp();

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/permissions/config/school',
      headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Nouveau Nom', city: 'Abidjan', teachingType: 'general' }),
    });

    expect(response.statusCode).toBe(200);

    await app.close();
  });

  // ── Cas 22 : POST /positions/:id/assign assigne un user à un poste ───────

  it('POST /api/v1/permissions/positions/:id/assign assigne un user à un poste', async () => {
    makeDirectorToken();

    // assignPosition: Promise.all([findPositionById, canReceivePositionAssignment])
    // puis: assignPosition INSERT + countAssignments
    mocks.dbExecute
      .mockResolvedValueOnce({ rows: [defaultSchoolConfigRow] })         // auth
      .mockResolvedValueOnce({ rows: [makePosition()] })                 // assignPosition: findPositionById (Promise.all #1)
      .mockResolvedValueOnce({ rows: [{ exists: true }] })               // assignPosition: canReceivePositionAssignment (Promise.all #2)
      .mockResolvedValueOnce({ rows: [{ id: 'assignment-id' }] })       // assignPosition: INSERT
      .mockResolvedValueOnce({ rows: [{ count: 1 }] });                  // assignPosition: countAssignments

    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/permissions/positions/${UUID_POSITION_1}/assign`,
      headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
      body: JSON.stringify({ userId: UUID_USER_20 }),
    });

    expect(response.statusCode).toBe(200);

    await app.close();
  });

  // ── Cas 23 : POST /positions/:id/assign retourne 400 si user non assignable ─

  it("POST /api/v1/permissions/positions/:id/assign retourne 400 si user n'est pas assignable (not staff)", async () => {
    makeDirectorToken();

    mocks.dbExecute
      .mockResolvedValueOnce({ rows: [defaultSchoolConfigRow] })  // auth
      .mockResolvedValueOnce({ rows: [makePosition()] })          // assignPosition: findPositionById
      .mockResolvedValueOnce({ rows: [{ exists: false }] });      // assignPosition: canReceivePositionAssignment

    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/permissions/positions/${UUID_POSITION_1}/assign`,
      headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
      body: JSON.stringify({ userId: UUID_USER_99 }),
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as { code: string };
    expect(body.code).toBe('INVALID_ASSIGNMENT_TARGET');

    await app.close();
  });

  // ── Cas 24 : DELETE /positions/:id/assign/:userId retire l'assignation ────

  it("DELETE /api/v1/permissions/positions/:id/assign/:userId retire l'assignation", async () => {
    makeDirectorToken();

    mocks.dbExecute
      .mockResolvedValueOnce({ rows: [defaultSchoolConfigRow] })         // auth
      .mockResolvedValueOnce({ rows: [makePosition({ assignments_count: 1 })] }) // unassignPosition: findPositionById
      .mockResolvedValueOnce({ rows: [{ id: 'assignment-id' }] })       // unassignPosition: DELETE RETURNING
      .mockResolvedValueOnce({ rows: [{ count: 0 }] });                  // unassignPosition: countAssignments

    const app = await buildApp();

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/permissions/positions/${UUID_POSITION_1}/assign/${UUID_USER_20}`,
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(response.statusCode).toBe(200);

    await app.close();
  });

  // ── Cas 25 : GET /me retourne 401 si token invalide ──────────────────────

  it('GET /api/v1/permissions/me retourne 401 si token invalide (jwt expired)', async () => {
    mocks.verifyAccessToken.mockRejectedValue(new Error('jwt expired'));

    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/permissions/me',
      headers: { authorization: 'Bearer expired-token' },
    });

    expect(response.statusCode).toBe(401);

    await app.close();
  });
});
