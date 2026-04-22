import 'dotenv/config';

import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { sql } from 'drizzle-orm';
import Fastify from 'fastify';
import { Redis } from 'ioredis';

import adminController from './modules/admin/admin.controller.js';
import attendanceController from './modules/attendance/attendance.controller.js';
import authController from './modules/auth/auth.controller.js';
import billingController, { billingPdfQueue } from './modules/billing/billing.controller.js';
import { createBillingPdfWorker } from './modules/billing/billing.queue.js';
import documentsController from './modules/documents/documents.controller.js';
import importExportController from './modules/import-export/import.controller.js';
import notificationsController from './modules/notifications/notifications.controller.js';
import permissionsController from './modules/permissions/permissions.controller.js';
import {
  createNotificationsQueue,
  createNotificationsWorker,
} from './modules/notifications/notifications.queue.js';
import { defaultRepository } from './modules/notifications/notifications.repository.js';
import { NotificationsService, defaultSmsSender } from './modules/notifications/notifications.service.js';
import roomsController from './modules/rooms/rooms.controller.js';
import schoolController from './modules/school/school.controller.js';
import studentsController from './modules/students/students.controller.js';
import scheduleController from './modules/schedule/schedule.controller.js';
import teachersController from './modules/teachers/teachers.controller.js';
import { db } from './shared/database/db.js';

const app = Fastify({ logger: true });
const port = Number(process.env.PORT || 3000);
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const notificationsRedis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const billingRedis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const notificationsQueue = createNotificationsQueue(notificationsRedis);
const billingWorker = createBillingPdfWorker(billingRedis);
const notificationsWorker = createNotificationsWorker(notificationsRedis, {
  repository: defaultRepository,
  smsSender: defaultSmsSender,
});
const notificationsService = new NotificationsService({
  smsQueue: notificationsQueue,
});
let maintenanceCache: {
  fetchedAt: number;
  mode: boolean;
  message: string;
} = {
  fetchedAt: 0,
  mode: false,
  message: 'Mise à jour en cours',
};

const loadMaintenanceState = async (): Promise<{ mode: boolean; message: string }> => {
  const now = Date.now();
  if (now - maintenanceCache.fetchedAt < 15000) {
    return { mode: maintenanceCache.mode, message: maintenanceCache.message };
  }

  try {
    const result = await db.execute<{
      maintenance_mode: boolean;
      maintenance_message: string;
    }>(sql.raw(`
      SELECT maintenance_mode, maintenance_message
      FROM public.app_settings
      ORDER BY updated_at DESC
      LIMIT 1
    `));

    const row = result.rows?.[0];
    maintenanceCache = {
      fetchedAt: now,
      mode: row?.maintenance_mode ?? false,
      message: row?.maintenance_message ?? 'Mise à jour en cours',
    };
  } catch (error) {
    app.log.warn(
      { err: error instanceof Error ? error.message : 'unknown' },
      '[maintenance] fallback disabled (app_settings unavailable)'
    );
    maintenanceCache = {
      fetchedAt: now,
      mode: false,
      message: 'Mise à jour en cours',
    };
  }

  return { mode: maintenanceCache.mode, message: maintenanceCache.message };
};

notificationsService.start();

app.register(cors, {
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
});
app.register(rateLimit, {
  global: false,
  skipOnError: true,
});
app.register(multipart, {
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});

app.addHook('onRequest', async (request, reply) => {
  const path = request.url.split('?')[0] ?? '';
  if (
    path.startsWith('/api/v1/admin') ||
    path.startsWith('/api/v1/auth') ||
    path === '/health'
  ) {
    return;
  }

  const state = await loadMaintenanceState();
  if (!state.mode) {
    return;
  }

  reply.code(503).send({
    error: state.message,
    code: 'MAINTENANCE_MODE',
    statusCode: 503,
  });
});

app.register(authController);
app.register(adminController);
app.register(attendanceController);
app.register(notificationsController);
app.register(billingController);
app.register(studentsController);
app.register(teachersController);
app.register(scheduleController);
app.register(roomsController);
app.register(documentsController);
app.register(schoolController);
app.register(importExportController);
app.register(permissionsController);

app.get('/health', async () => ({ status: 'ok' }));

app.addHook('onClose', async () => {
  notificationsService.stop();
  await billingWorker.close();
  await billingPdfQueue.close();
  await billingRedis.quit();
  await notificationsWorker.close();
  await notificationsQueue.close();
  await notificationsRedis.quit();
});

const start = async (): Promise<void> => {
  try {
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`Server listening on port ${port}`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

void start();
