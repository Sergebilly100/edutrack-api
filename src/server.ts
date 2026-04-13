import 'dotenv/config';

import cors from '@fastify/cors';
import Fastify from 'fastify';

import authController from './modules/auth/auth.controller.js';

const app = Fastify({ logger: true });
const port = Number(process.env.PORT || 3000);

app.register(cors, {
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
});

app.register(authController);

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
