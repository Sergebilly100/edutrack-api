import 'dotenv/config';

import cors from '@fastify/cors';
import Fastify from 'fastify';

import adminController from './modules/admin/admin.controller.js';
import authController from './modules/auth/auth.controller.js';
import roomsController from './modules/rooms/rooms.controller.js';
import studentsController from './modules/students/students.controller.js';
import scheduleController from './modules/schedule/schedule.controller.js';

const app = Fastify({ logger: true });
const port = Number(process.env.PORT || 3000);

app.register(cors, {
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
});

app.register(authController);
app.register(adminController);
app.register(studentsController);
app.register(scheduleController);
app.register(roomsController);

app.get('/health', async () => ({ status: 'ok' }));

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
