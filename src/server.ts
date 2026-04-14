import 'dotenv/config';

import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import { Redis } from 'ioredis';

import adminController from './modules/admin/admin.controller.js';
import attendanceController from './modules/attendance/attendance.controller.js';
import authController from './modules/auth/auth.controller.js';
import importExportController from './modules/import-export/import.controller.js';
import {
  createNotificationsQueue,
  createNotificationsWorker,
} from './modules/notifications/notifications.queue.js';
import { defaultRepository } from './modules/notifications/notifications.repository.js';
import { NotificationsService, defaultSmsSender } from './modules/notifications/notifications.service.js';
import roomsController from './modules/rooms/rooms.controller.js';
import studentsController from './modules/students/students.controller.js';
import scheduleController from './modules/schedule/schedule.controller.js';

const app = Fastify({ logger: true });
const port = Number(process.env.PORT || 3000);
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const notificationsRedis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const notificationsQueue = createNotificationsQueue(notificationsRedis);
const notificationsWorker = createNotificationsWorker(notificationsRedis, {
  repository: defaultRepository,
  smsSender: defaultSmsSender,
});
const notificationsService = new NotificationsService({
  smsQueue: notificationsQueue,
});

notificationsService.start();

app.register(cors, {
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
});
app.register(multipart, {
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

app.register(authController);
app.register(adminController);
app.register(attendanceController);
app.register(studentsController);
app.register(scheduleController);
app.register(roomsController);
app.register(importExportController);

app.get('/health', async () => ({ status: 'ok' }));

app.addHook('onClose', async () => {
  notificationsService.stop();
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
