import 'dotenv/config';

import { randomBytes } from 'node:crypto';

import multipart from '@fastify/multipart';
import argon2 from 'argon2';
import Fastify, { type FastifyInstance } from 'fastify';
import { importPKCS8, SignJWT } from 'jose';
import { Pool, type QueryResultRow } from 'pg';
import supertest from 'supertest';
import { afterAll, afterEach, beforeAll } from 'vitest';

type TestRole = 'teacher' | 'director' | 'secretary' | 'super_admin';

type SeedContext = {
  schemaName: string;
  className: string;
  scheduleId: string;
  teacherId: string;
  teacherUserId: string;
  teacherUsername: string;
  teacherPassword: string;
  directorUserId: string;
  secretaryUserId: string;
  directorPassword: string;
  secretaryPassword: string;
  validRoomToken: string;
};

const DATABASE_URL_TEST = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
if (!DATABASE_URL_TEST) {
  throw new Error(
    '[integration] DATABASE_URL_TEST is required (or DATABASE_URL as fallback).'
  );
}

// Force all app DB imports to point to the isolated test database.
process.env.DATABASE_URL = DATABASE_URL_TEST;

const schemaSuffix = randomBytes(4).toString('hex');
export const TEST_SCHEMA_NAME = `school_test_${schemaSuffix}`;

const pool = new Pool({
  connectionString: DATABASE_URL_TEST,
});

let app: FastifyInstance | null = null;
let seedContext: SeedContext | null = null;
let privateKeyPromise: Promise<Awaited<ReturnType<typeof importPKCS8>>> | null = null;

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
  const result = await pool.query<TRow>(text, values);
  return result.rows;
};

const normalizePem = (value: string): string =>
  value
    .replace(/\\n/g, '\n')   // \n littéraux → vrais sauts de ligne
    .replace(/\r\n/g, '\n')  // CRLF → LF
    .trim();                  // espaces/sauts de ligne en début/fin
    
const getPrivateKey = async (): Promise<Awaited<ReturnType<typeof importPKCS8>>> => {
  if (privateKeyPromise) {
    return privateKeyPromise;
  }

  const rawPrivateKey = process.env.JWT_PRIVATE_KEY;
  if (!rawPrivateKey) {
    throw new Error('[integration] JWT_PRIVATE_KEY is required');
  }

  privateKeyPromise = importPKCS8(normalizePem(rawPrivateKey), 'RS256');
  return privateKeyPromise;
};

const getContext = (): SeedContext => {
  if (!seedContext) {
    throw new Error('[integration] Seed context is not initialized');
  }

  return seedContext;
};

export const getSeedContext = (): SeedContext => getContext();

export const getToken = async (role: TestRole): Promise<string> => {
  const context = getContext();
  const privateKey = await getPrivateKey();

  const subject =
    role === 'teacher'
      ? context.teacherUserId
      : role === 'secretary'
        ? context.secretaryUserId
        : context.directorUserId;
  const payload = {
    sub: subject,
    role,
    schemaName: context.schemaName,
    ...(role === 'teacher' ? { username: context.teacherUsername } : {}),
  };

  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime(process.env.JWT_EXPIRY ?? '15m')
    .sign(privateKey);
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
  const secretaryPassword = 'secretary2024';
  const teacherPasswordHash = await argon2.hash(teacherPassword);
  const directorPasswordHash = await argon2.hash(directorPassword);
  const secretaryPasswordHash = await argon2.hash(secretaryPassword);

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

    const secretaryResult = await client.query<{ id: string }>(
      `
        INSERT INTO users (role, name, phone, email, password_hash, is_active)
        VALUES ('secretary', 'Integration Secretary', '2250702345678', 'secretary.integration@edutrack.local', $1, true)
        RETURNING id
      `,
      [secretaryPasswordHash]
    );

    const teacherUserId = teacherUserResult.rows[0]?.id;
    const directorUserId = directorResult.rows[0]?.id;
    const secretaryUserId = secretaryResult.rows[0]?.id;
    if (!teacherUserId || !directorUserId || !secretaryUserId) {
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
      secretaryUserId,
      directorPassword,
      secretaryPassword,
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
    { default: attendanceController },
    { default: billingController },
    { default: scheduleController },
    { default: importExportController },
    { default: permissionsController },
    { default: teachersController },
  ] = await Promise.all([
    import('../../src/modules/auth/auth.controller.js'),
    import('../../src/modules/attendance/attendance.controller.js'),
    import('../../src/modules/billing/billing.controller.js'),
    import('../../src/modules/schedule/schedule.controller.js'),
    import('../../src/modules/import-export/import.controller.js'),
    import('../../src/modules/permissions/permissions.controller.js'),
    import('../../src/modules/teachers/teachers.controller.js'),
  ]);

  const testApp = Fastify({ logger: false });
  testApp.register(multipart, {
    limits: {
      fileSize: 5 * 1024 * 1024,
    },
  });

  testApp.register(authController);
  testApp.register(attendanceController);
  testApp.register(billingController);
  testApp.register(scheduleController);
  testApp.register(importExportController);
  testApp.register(permissionsController);
  testApp.register(teachersController);

  await testApp.ready();
  return testApp;
};

beforeAll(async () => {
  const { createTenantSchema } = await import('../../src/shared/database/tenant-init.js');
  await createTenantSchema(TEST_SCHEMA_NAME);
  seedContext = await seedTenantData();
  app = await initApp();
});

afterEach(async () => {
  await truncateAttendanceTables();
});

afterAll(async () => {
  if (app) {
    await app.close();
    app = null;
  }

  await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(TEST_SCHEMA_NAME)} CASCADE`);
  await pool.end();
});
