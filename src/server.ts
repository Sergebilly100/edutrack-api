import 'dotenv/config';

import cors from '@fastify/cors';
import etag from '@fastify/etag';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { sql } from 'drizzle-orm';
import Fastify from 'fastify';

import { Queue, Worker } from 'bullmq';
import { closeSharedRedis, getSharedRedis } from './shared/queue/shared-redis.js';

import { assertRequiredSecrets } from './shared/utils/required-secrets.js';
import { initSentry, captureException, isSentryEnabled } from './shared/observability/sentry.js';
import { registerSwagger } from './shared/observability/swagger.js';

assertRequiredSecrets();
initSentry();

import adminController from './modules/admin/admin.controller.js';
import attendanceController from './modules/attendance/attendance.controller.js';
import { runAttendanceMissingQrScanHandler } from './modules/attendance/attendance.worker-handler.js';
import { runAbsenceMarkingForSchema } from './modules/attendance/attendance.absence-marking.worker.js';
import { geoAutoApproveWorker, scheduleGeoAutoApprove } from './modules/attendance/attendance.geo-auto-approve.worker.js';
import authController from './modules/auth/auth.controller.js';
import billingController from './modules/billing/billing.controller.js'
import dashboardController from './modules/dashboard/dashboard.controller.js';
import { createBillingPdfQueue } from './modules/billing/billing.queue.js'
import { createBillingPdfWorker } from './modules/billing/billing.queue.js';
import documentsController from './modules/documents/documents.controller.js';
import importExportController from './modules/import-export/import.controller.js';
import notificationsController from './modules/notifications/notifications.controller.js';
import permissionsController from './modules/permissions/permissions.controller.js';
import parentPortalController from './modules/parent-portal/parent-portal.controller.js';
import {
  createNotificationsQueue,
  createNotificationsWorker,
} from './modules/notifications/notifications.queue.js';
import { defaultRepository } from './modules/notifications/notifications.repository.js';
import {
  NotificationsService,
  defaultEmailSender,
  defaultSmsSender,
} from './modules/notifications/notifications.service.js';
import roomsController from './modules/rooms/rooms.controller.js';
import schoolController from './modules/school/school.controller.js';
import subscriptionsController from './modules/subscriptions/subscriptions.controller.js';
import {
  createSubscriptionMaintenanceQueue,
  createSubscriptionMaintenanceWorker,
} from './modules/subscriptions/subscriptions.maintenance.js';
import studentsController from './modules/students/students.controller.js';
import scheduleController from './modules/schedule/schedule.controller.js';
import teachersController from './modules/teachers/teachers.controller.js';
import validationsController from './modules/validations/validations.controller.js';
import { db } from './shared/database/db.js';
import { registerSalaryEventListeners } from './modules/salaries/salaries.service.js';
import { qrAlertQueue, geoAutoApproveQueue } from './shared/queue/queue.js';
import {
  attachFailedHandler,
  createDeadLetterQueue,
} from './shared/queue/dead-letter-queue.js';

const app = Fastify({ logger: true, trustProxy: 1 });
const port = Number(process.env.PORT || 3000);
const sharedRedis = getSharedRedis();
const deadLetterQueue = createDeadLetterQueue(sharedRedis);
const billingPdfQueue = createBillingPdfQueue(sharedRedis)
const notificationsQueue = createNotificationsQueue(sharedRedis);
const billingWorker = createBillingPdfWorker(sharedRedis);
const subscriptionsMaintenanceQueue = createSubscriptionMaintenanceQueue(sharedRedis);
const subscriptionsMaintenanceWorker = createSubscriptionMaintenanceWorker(sharedRedis);
const notificationsWorker = createNotificationsWorker(sharedRedis, {
  repository: defaultRepository,
  smsSender: defaultSmsSender,
  emailSender: defaultEmailSender,
});

attachFailedHandler(notificationsWorker, 'notifications-sms', { deadLetterQueue, logger: app.log });
attachFailedHandler(billingWorker, 'billing-pdf', { deadLetterQueue, logger: app.log });
attachFailedHandler(subscriptionsMaintenanceWorker, 'subscription-maintenance', { deadLetterQueue, logger: app.log });
const qrAlertWorker = new Worker(
  'qr-alert',
  async (job) => {
    await runAttendanceMissingQrScanHandler({
      schemaName: job.data.schemaName,
      date: job.data.date,
    });
  },
  {
    connection: sharedRedis,
    concurrency: Number(process.env.QR_WORKER_CONCURRENCY ?? 5),
  }
);
attachFailedHandler(qrAlertWorker, 'qr-alert', { deadLetterQueue, logger: app.log });
const absenceMarkingQueue = new Queue('absence-marking', { connection: sharedRedis });
const absenceMarkingWorker = new Worker(
  'absence-marking',
  async (job) => {
    await runAbsenceMarkingForSchema({ schemaName: job.data.schemaName });
  },
  {
    connection: sharedRedis,
    concurrency: Number(process.env.ABSENCE_MARKING_WORKER_CONCURRENCY ?? 5),
  }
);
attachFailedHandler(absenceMarkingWorker, 'absence-marking', { deadLetterQueue, logger: app.log });
attachFailedHandler(geoAutoApproveWorker, 'geo-auto-approve', { deadLetterQueue, logger: app.log });
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
registerSalaryEventListeners();

const corsOrigins = process.env.CORS_ORIGINS
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (process.env.NODE_ENV === 'production' && (!corsOrigins || corsOrigins.length === 0)) {
  throw new Error('CORS_ORIGINS environment variable is required in production');
}

app.register(cors, {
  origin: corsOrigins && corsOrigins.length > 0 ? corsOrigins : true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
});
app.register(helmet, {
  contentSecurityPolicy: false,
  hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
  crossOriginResourcePolicy: { policy: 'same-site' },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
});
app.register(rateLimit, {
  global: false,
  skipOnError: true,
});
app.register(etag);
app.register(multipart, {
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});

if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_SWAGGER === 'true') {
  void registerSwagger(app);
}

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
app.register(adminController, { deadLetterQueue });
app.register(attendanceController);
app.register(dashboardController);
app.register(notificationsController, { smsQueue: notificationsQueue });
app.register(billingController, { billingPdfQueue })
app.register(studentsController);
app.register(teachersController);
app.register(validationsController);
app.register(scheduleController);
app.register(roomsController);
app.register(documentsController);
app.register(schoolController);
app.register(importExportController);
app.register(permissionsController);
app.register(subscriptionsController);
app.register(parentPortalController);

app.get('/health', async () => ({ status: 'ok' }));

app.get('/ready', async (_request, reply) => {
  const checks: { db: boolean; redis: boolean } = { db: false, redis: false };
  try {
    await db.execute(sql`SELECT 1`);
    checks.db = true;
  } catch (error) {
    app.log.warn({ err: error instanceof Error ? error.message : 'unknown' }, '[ready] db check failed');
  }
  try {
    await sharedRedis.ping();
    checks.redis = true;
  } catch (error) {
    app.log.warn({ err: error instanceof Error ? error.message : 'unknown' }, '[ready] redis check failed');
  }
  if (!checks.db || !checks.redis) {
    return reply.code(503).send({ status: 'not_ready', checks });
  }
  return reply.send({ status: 'ready', checks });
});

app.addHook('onResponse', async (request, reply) => {
  request.log.info(
    {
      tenant_id: request.claims?.tenantId,
      schema: request.claims?.schemaName,
      user_id: request.claims?.sub,
      role: request.claims?.role,
      method: request.method,
      url: request.url,
      status: reply.statusCode,
      duration_ms: reply.elapsedTime,
    },
    'http_response'
  );
});

if (isSentryEnabled()) {
  app.setErrorHandler((rawError, request, reply) => {
    const error = rawError as Error & { statusCode?: number; code?: string };
    captureException(error, {
      schemaName: request.claims?.schemaName,
      userId: request.claims?.sub,
      tenantId: request.claims?.tenantId,
      route: request.routeOptions?.url ?? request.url,
    });
    request.log.error({ err: error.message, url: request.url }, 'request_error');
    if (reply.sent) return;
    const statusCode = error.statusCode ?? 500;
    reply.code(statusCode).send({
      error: statusCode >= 500 ? 'Internal error' : error.message,
      code: statusCode >= 500 ? 'INTERNAL' : (error.code ?? 'ERROR'),
      statusCode,
    });
  });
}

app.addHook('onClose', async () => {
  notificationsService.stop();
  await billingWorker.close();
  await billingPdfQueue.close();
  await notificationsWorker.close();
  await notificationsQueue.close();
  await subscriptionsMaintenanceWorker.close();
  await subscriptionsMaintenanceQueue.close();
  await qrAlertWorker.close();
  await qrAlertQueue.close();
  await absenceMarkingWorker.close();
  await absenceMarkingQueue.close();
  await geoAutoApproveWorker.close();
  await geoAutoApproveQueue.close();
  await deadLetterQueue.close();
  await closeSharedRedis();
});

const start = async (): Promise<void> => {
  try {
    const subscriptionMaintenanceSchemaName =
      process.env.SUBSCRIPTION_MAINTENANCE_SCHEMA ?? 'school_sainte_marie';

    // Schedule geo auto-approve job (daily at 3 AM)
    await scheduleGeoAutoApprove();

    // On ne garde que les tenants dont le schéma PG existe réellement.
    // public.tenants accumule des lignes orphelines (tests d'intégration qui
    // suppriment le schéma sans nettoyer la ligne) ; enregistrer un scheduler
    // pour ces schémas inexistants faisait planter le job mark-absences en
    // boucle toutes les 15 min.
    const activeTenantsResult = await db.execute<{ id: string; schema_name: string }>(sql`
      SELECT t.id::text AS id, t.schema_name
      FROM public.tenants t
      WHERE t.status IN ('trial', 'active')
        AND EXISTS (
          SELECT 1
          FROM information_schema.schemata s
          WHERE s.schema_name = t.schema_name
        )
      ORDER BY t.created_at ASC
    `);
    const activeTenants = activeTenantsResult.rows ?? [];
    if (activeTenants.length === 0) {
      const fallbackSchema =
        process.env.ABSENCE_MARKING_SCHEMA ?? process.env.SUBSCRIPTION_MAINTENANCE_SCHEMA ?? 'school_sainte_marie';
      await absenceMarkingQueue.upsertJobScheduler(
        `absence-marking-${fallbackSchema}`,
        { pattern: '*/15 6-18 * * 1-6', tz: 'Africa/Abidjan' },
        { name: 'mark-absences', data: { schemaName: fallbackSchema } }
      );
      app.log.warn(
        { fallbackSchema },
        '[absence-marking] no active/trial tenants found — registered fallback scheduler only'
      );
    } else {
      for (const tenant of activeTenants) {
        await absenceMarkingQueue.upsertJobScheduler(
          `absence-marking-${tenant.id}`,
          { pattern: '*/15 6-18 * * 1-6', tz: 'Africa/Abidjan' },
          { name: 'mark-absences', data: { schemaName: tenant.schema_name } }
        );
      }
      app.log.info(
        { count: activeTenants.length },
        `[absence-marking] registered schedulers for ${activeTenants.length} active tenants`
      );
    }

    await subscriptionsMaintenanceQueue.upsertJobScheduler(
      'subscription-maintenance-daily',
      {
        pattern: '0 8 * * *',
        tz: 'Africa/Abidjan',
      },
      {
        name: 'daily-subscription-maintenance',
        data: { schemaName: subscriptionMaintenanceSchemaName },
      }
    );
    await notificationsQueue.upsertJobScheduler(
      'teacher-daily-summary-18h',
      {
        pattern: '0 18 * * *',
        tz: 'Africa/Abidjan',
      },
      {
        name: 'teacher-daily-summary-all',
        data: { type: 'teacher-daily-summary-all' },
      }
    );
    await notificationsQueue.upsertJobScheduler(
      'validation-daily-summary-9h',
      {
        pattern: '0 9 * * 1-6',
        tz: 'Africa/Abidjan',
      },
      {
        name: 'validation-daily-summary-all',
        data: { type: 'validation-daily-summary-all' },
      }
    );
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`Server listening on port ${port}`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

void start();
