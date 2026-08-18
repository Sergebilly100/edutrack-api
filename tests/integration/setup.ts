import 'dotenv/config';

import { generateKeyPairSync, randomBytes } from 'node:crypto';

import multipart from '@fastify/multipart';
import argon2 from 'argon2';
import Fastify, { type FastifyInstance } from 'fastify';
import { Pool, type QueryResultRow } from 'pg';
import supertest from 'supertest';
import { afterAll, afterEach, beforeAll } from 'vitest';

type TestRole = 'teacher' | 'director' | 'staff' | 'super_admin';

type SeedContext = {
  schemaName: string;
  className: string;
  scheduleId: string;
  teacherId: string;
  teacherUserId: string;
  teacherUsername: string;
  teacherPassword: string;
  directorUserId: string;
  staffUserId: string;
  superAdminUserId: string;
  directorPassword: string;
  staffPassword: string;
  superAdminPassword: string;
  validRoomToken: string;
};

const DATABASE_URL_TEST = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
if (!DATABASE_URL_TEST) {
  throw new Error(
    '[integration] DATABASE_URL_TEST is required (or DATABASE_URL as fallback).'
  );
}

const ensureJwtKeysForIntegration = (): void => {
  // Always use a fresh keypair for integration tests to avoid CI env formatting issues
  // (quoted PEM, escaped newlines, multiline export edge cases).
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  process.env.JWT_PRIVATE_KEY = privateKey;
  process.env.JWT_PUBLIC_KEY = publicKey;
};

ensureJwtKeysForIntegration();

// Force all app DB imports to point to the isolated test database.
process.env.DATABASE_URL = DATABASE_URL_TEST;

// Provide default values for env vars required by import flows in integration tests.
process.env.IMPORT_TEACHER_DEFAULT_PASSWORD =
  process.env.IMPORT_TEACHER_DEFAULT_PASSWORD ?? 'TestTeacherPass!2026';

const schemaSuffix = randomBytes(4).toString('hex');
export const TEST_SCHEMA_NAME = `school_test_${schemaSuffix}`;

const pool = new Pool({
  connectionString: DATABASE_URL_TEST,
});

let app: FastifyInstance | null = null;
let seedContext: SeedContext | null = null;

const IDENTIFIER_REGEX = /^[a-z_][a-z0-9_]*$/;

const quoteIdentifier = (identifier: string): string => {
  if (!IDENTIFIER_REGEX.test(identifier)) {
    throw new Error(`[integration] Invalid SQL identifier: ${identifier}`);
  }

  return `"${identifier}"`;
};

export const tenantTable = (tableName: string): string => {
  return `${quoteIdentifier(TEST_SCHEMA_NAME)}.${quoteIdentifier(tableName)}`;
};

export const queryTenant = async <TRow extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = []
): Promise<TRow[]> => {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO ${quoteIdentifier(TEST_SCHEMA_NAME)}, public`);
    const result = await client.query<TRow>(text, values);
    return result.rows;
  } finally {
    client.release();
  }
};

export const queryPublic = async <TRow extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = []
): Promise<TRow[]> => {
  const result = await pool.query<TRow>(text, values);
  return result.rows;
};

const getContext = (): SeedContext => {
  if (!seedContext) {
    throw new Error('[integration] Seed context is not initialized');
  }

  return seedContext;
};

export const getSeedContext = (): SeedContext => getContext();

const getJwtDebugSnapshot = (): string => {
  const privateKey = process.env.JWT_PRIVATE_KEY ?? '';
  const publicKey = process.env.JWT_PUBLIC_KEY ?? '';
  return JSON.stringify({
    hasPrivateKey: privateKey.length > 0,
    hasPublicKey: publicKey.length > 0,
    privateKeyLength: privateKey.length,
    publicKeyLength: publicKey.length,
    privateKeyPrefix: privateKey.slice(0, 30),
    publicKeyPrefix: publicKey.slice(0, 30),
  });
};

const getLoginCredentials = (
  role: TestRole,
  context: SeedContext
): { identifier: string; password: string } => {
  if (role === 'teacher') {
    return {
      identifier: context.teacherUsername,
      password: context.teacherPassword,
    };
  }

  if (role === 'director') {
    return {
      identifier: '2250701234567',
      password: context.directorPassword,
    };
  }

  if (role === 'staff') {
    return {
      identifier: '2250702345678',
      password: context.staffPassword,
    };
  }

  if (role === 'super_admin') {
    return {
      identifier: 'superadmin.integration@edutrack.local',
      password: context.superAdminPassword,
    };
  }

  throw new Error(`[integration] Unsupported role for tenant auth: ${role}`);
};

export const getToken = async (role: TestRole): Promise<string> => {
  const context = getContext();
  const credentials = getLoginCredentials(role, context);
  const loginEndpoint =
    role === 'super_admin' ? '/api/v1/auth/login/admin' : '/api/v1/auth/login/teacher';
  const loginResponse = await request()
    .post(loginEndpoint)
    .set('x-tenant-schema', TEST_SCHEMA_NAME)
    .send(credentials);

  if (loginResponse.status !== 200 || typeof loginResponse.body?.accessToken !== 'string') {
    throw new Error(
      `[integration] Unable to fetch access token for role=${role} (status=${loginResponse.status}) body=${JSON.stringify(loginResponse.body)} jwt=${getJwtDebugSnapshot()}`
    );
  }

  return loginResponse.body.accessToken;
};

export const getAuthHeaders = async (role: TestRole): Promise<Record<string, string>> => {
  const token = await getToken(role);
  return {
    authorization: `Bearer ${token}`,
    'x-tenant-schema': TEST_SCHEMA_NAME,
  };
};

export const request = () => {
  if (!app) {
    throw new Error('[integration] Fastify app is not initialized');
  }

  return supertest(app.server);
};

const formatDate = (date: Date): string => date.toISOString().slice(0, 10);

const addDays = (date: Date, days: number): Date => {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

const getCurrentDayOfWeek = (): number => {
  const day = new Date().getUTCDay();
  return day === 0 ? 1 : day;
};

const toTimeFromUtcMinutes = (minutes: number): string => {
  const clamped = Math.max(0, Math.min(minutes, 23 * 60 + 59));
  const hours = Math.floor(clamped / 60);
  const mins = clamped % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:00`;
};

const seedTenantData = async (): Promise<SeedContext> => {
  const teacherPassword = 'edutrack2024';
  const directorPassword = 'director2024';
  const staffPassword = 'staff2024';
  const superAdminPassword = 'SuperAdmin!2024';
  const teacherPasswordHash = await argon2.hash(teacherPassword);
  const directorPasswordHash = await argon2.hash(directorPassword);
  const staffPasswordHash = await argon2.hash(staffPassword);
  const superAdminPasswordHash = await argon2.hash(superAdminPassword);

  const now = new Date();
  const validFrom = formatDate(addDays(now, -7));
  const validTo = formatDate(addDays(now, 7));
  const dayOfWeek = getCurrentDayOfWeek();

  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  let slotStartMinutes = Math.max(0, nowMinutes - 5);
  let slotEndMinutes = Math.min(23 * 60 + 59, nowMinutes + 55);

  if (slotEndMinutes <= slotStartMinutes) {
    slotStartMinutes = Math.max(0, nowMinutes - 30);
    slotEndMinutes = Math.min(23 * 60 + 59, slotStartMinutes + 60);
  }

  const slotStartTime = toTimeFromUtcMinutes(slotStartMinutes);
  const slotEndTime = toTimeFromUtcMinutes(slotEndMinutes);
  const slotLabel = `test-slot-${schemaSuffix}`;

  const tenantSchema = quoteIdentifier(TEST_SCHEMA_NAME);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO ${tenantSchema}, public`);

    const directorResult = await client.query<{ id: string }>(
      `
        INSERT INTO users (role, name, phone, email, password_hash, is_active)
        VALUES ('director', 'Integration Director', '2250701234567', 'director.integration@edutrack.local', $1, true)
        RETURNING id
      `,
      [directorPasswordHash]
    );

    const teacherUserResult = await client.query<{ id: string }>(
      `
        INSERT INTO users (role, name, phone, email, password_hash, is_active)
        VALUES ('teacher', 'Integration Teacher', null, 'teacher.integration@edutrack.local', $1, true)
        RETURNING id
      `,
      [teacherPasswordHash]
    );

    const staffResult = await client.query<{ id: string }>(
      `
        INSERT INTO users (role, name, phone, email, password_hash, is_active)
        VALUES ('staff', 'Integration Staff', '2250702345678', 'staff.integration@edutrack.local', $1, true)
        RETURNING id
      `,
      [staffPasswordHash]
    );

    const superAdminResult = await client.query<{ id: string }>(
      `
        INSERT INTO users (role, name, phone, email, password_hash, is_active)
        VALUES ('super_admin', 'Integration SuperAdmin', null, 'superadmin.integration@edutrack.local', $1, true)
        RETURNING id
      `,
      [superAdminPasswordHash]
    );

    const teacherUserId = teacherUserResult.rows[0]?.id;
    const directorUserId = directorResult.rows[0]?.id;
    const staffUserId = staffResult.rows[0]?.id;
    const superAdminUserId = superAdminResult.rows[0]?.id;
    if (!teacherUserId || !directorUserId || !staffUserId || !superAdminUserId) {
      throw new Error('[integration] Failed to seed users');
    }

    const teacherUsername = `diallo.test${schemaSuffix.slice(0, 4)}`;
    const teacherResult = await client.query<{ id: string }>(
      `
        INSERT INTO teachers (user_id, username, type, subjects, hourly_rate)
        VALUES ($1, $2, 'vacataire', $3::text[], 5000)
        RETURNING id
      `,
      [teacherUserId, teacherUsername, ['Mathematiques']]
    );

    const teacherId = teacherResult.rows[0]?.id;
    if (!teacherId) {
      throw new Error('[integration] Failed to seed teacher');
    }

    const className = `3eme A ${schemaSuffix}`;
    const classResult = await client.query<{ id: string }>(
      `
        INSERT INTO classes (name, level, student_count)
        VALUES ($1, '3eme', 0)
        RETURNING id
      `,
      [className]
    );

    const classId = classResult.rows[0]?.id;
    if (!classId) {
      throw new Error('[integration] Failed to seed class');
    }

    const roomResult = await client.query<{ id: string; qr_token: string }>(
      `
        SELECT id, qr_token
        FROM rooms
        WHERE name = 'Salle A1'
        LIMIT 1
      `
    );

    const room = roomResult.rows[0];
    if (!room) {
      throw new Error('[integration] Missing default room Salle A1');
    }

    const slotResult = await client.query<{ id: string }>(
      `
        INSERT INTO time_slots (label, start_time, end_time, sort_order)
        VALUES ($1, $2::time, $3::time, 99)
        RETURNING id
      `,
      [slotLabel, slotStartTime, slotEndTime]
    );

    const timeSlotId = slotResult.rows[0]?.id;
    if (!timeSlotId) {
      throw new Error('[integration] Failed to seed time slot');
    }

    const periodResult = await client.query<{ id: string }>(
      `
        INSERT INTO schedule_periods (name, valid_from, valid_to, is_active, created_by)
        VALUES ($1, $2::date, $3::date, true, $4)
        RETURNING id
      `,
      [`Integration Period ${schemaSuffix}`, validFrom, validTo, directorUserId]
    );

    const periodId = periodResult.rows[0]?.id;
    if (!periodId) {
      throw new Error('[integration] Failed to seed schedule period');
    }

    const scheduleResult = await client.query<{ id: string }>(
      `
        INSERT INTO schedules (
          schedule_period_id,
          teacher_id,
          class_id,
          room_id,
          time_slot_id,
          day_of_week,
          subject,
          is_active
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'Mathematiques', true)
        RETURNING id
      `,
      [periodId, teacherId, classId, room.id, timeSlotId, dayOfWeek]
    );

    const scheduleId = scheduleResult.rows[0]?.id;
    if (!scheduleId) {
      throw new Error('[integration] Failed to seed schedule');
    }

    await client.query('COMMIT');

    return {
      schemaName: TEST_SCHEMA_NAME,
      className,
      scheduleId,
      teacherId,
      teacherUserId,
      teacherUsername,
      teacherPassword,
      directorUserId,
      staffUserId,
      superAdminUserId,
      directorPassword,
      staffPassword,
      superAdminPassword,
      validRoomToken: room.qr_token,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const truncateAttendanceTables = async (): Promise<void> => {
  await pool.query(
    `
      TRUNCATE TABLE
        ${tenantTable('attendances_student')},
        ${tenantTable('attendances_teacher')}
      RESTART IDENTITY CASCADE
    `
  );
};

const initApp = async (): Promise<FastifyInstance> => {
  const [
    { default: authController },
    { default: academicController },
    { default: classDecisionsController },
    { default: adminController },
    { default: attendanceController },
    { default: billingController },
    { default: scheduleController },
    { default: importExportController },
    { default: permissionsController },
    { default: teachersController },
    { default: subscriptionsController },
    { default: studentsController },
    { default: parentPortalController },
    { default: validationsController },
    { default: roomsController },
  ] = await Promise.all([
    import('../../src/modules/auth/auth.controller.js'),
    import('../../src/modules/academic/academic.controller.js'),
    import('../../src/modules/class-decisions/class-decisions.controller.js'),
    import('../../src/modules/admin/admin.controller.js'),
    import('../../src/modules/attendance/attendance.controller.js'),
    import('../../src/modules/billing/billing.controller.js'),
    import('../../src/modules/schedule/schedule.controller.js'),
    import('../../src/modules/import-export/import.controller.js'),
    import('../../src/modules/permissions/permissions.controller.js'),
    import('../../src/modules/teachers/teachers.controller.js'),
    import('../../src/modules/subscriptions/subscriptions.controller.js'),
    import('../../src/modules/students/students.controller.js'),
    import('../../src/modules/parent-portal/parent-portal.controller.js'),
    import('../../src/modules/validations/validations.controller.js'),
    import('../../src/modules/rooms/rooms.controller.js'),
  ]);

  const testApp = Fastify({ logger: false });
  testApp.register(multipart, {
    limits: {
      fileSize: 5 * 1024 * 1024,
    },
  });
  const smsQueue = {
    add: async () => ({ id: 'integration-notification-job' }),
  };

  testApp.register(authController);
  testApp.register(academicController);
  testApp.register(classDecisionsController);
  testApp.register(adminController);
  testApp.register(attendanceController);
  testApp.register(billingController);
  testApp.register(scheduleController);
  testApp.register(importExportController);
  testApp.register(permissionsController);
  testApp.register(teachersController);
  testApp.register(subscriptionsController, { smsQueue: smsQueue as never });
  testApp.register(studentsController, { smsQueue: smsQueue as never });
  testApp.register(parentPortalController);
  testApp.register(validationsController);
  testApp.register(roomsController);

  await testApp.ready();
  return testApp;
};

const assertBootstrapLogin = async (): Promise<void> => {
  const context = getContext();

  const runLogin = async () =>
    request()
      .post('/api/v1/auth/login/teacher')
      .set({
        'x-tenant-schema': TEST_SCHEMA_NAME,
      })
      .send({
        identifier: context.teacherUsername,
        password: context.teacherPassword,
      });

  let loginResponse = await runLogin();
  if (loginResponse.status === 200) {
    return;
  }

  // Retry once with a fresh keypair in case CI injected malformed keys.
  ensureJwtKeysForIntegration();
  loginResponse = await runLogin();
  if (loginResponse.status === 200) {
    return;
  }

  throw new Error(
    `[integration] bootstrap login failed status=${loginResponse.status} body=${JSON.stringify(loginResponse.body)} jwt=${getJwtDebugSnapshot()}`
  );
};

beforeAll(async () => {
  const { createTenantSchema } = await import('../../src/shared/database/tenant-init.js');
  await createTenantSchema(TEST_SCHEMA_NAME);
  seedContext = await seedTenantData();
  app = await initApp();
  await assertBootstrapLogin();
});

afterEach(async () => {
  await truncateAttendanceTables();
});

// Filet de sécurité : les tests insèrent des lignes dans public.tenants (directement
// ou via l'API createTenant) mais leur teardown ne fait souvent qu'un DROP SCHEMA,
// laissant des lignes orphelines qui s'accumulent à chaque run. On purge ici TOUS les
// schémas de test (school_test_* / school_d6_*) et leurs lignes enfants, en respectant
// l'ordre des FK, sans jamais toucher au tenant réel (school_sainte_marie).
const purgeOrphanTestTenants = async (): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TEMP TABLE _orphan_test_tenant_ids ON COMMIT DROP AS
        SELECT id FROM public.tenants
        WHERE schema_name <> 'school_sainte_marie'
          AND schema_name ~ '^school_(test|d6)_'
    `);
    // Enfants avant parents (6 FK vers public.tenants).
    for (const table of [
      'admin_access_log',
      'audit_financial_events',
      'school_sms_features',
      'edutrack_commission_records',
      'subscriptions',
      'sms_templates',
    ]) {
      await client.query(
        `DELETE FROM public.${table} WHERE tenant_id IN (SELECT id FROM _orphan_test_tenant_ids)`
      );
    }
    await client.query(
      `DELETE FROM public.tenants WHERE id IN (SELECT id FROM _orphan_test_tenant_ids)`
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

afterAll(async () => {
  if (app) {
    await app.close();
    app = null;
  }

  await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(TEST_SCHEMA_NAME)} CASCADE`);
  await purgeOrphanTestTenants();
  await pool.end();
});
