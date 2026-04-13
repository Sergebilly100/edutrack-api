import 'dotenv/config';

import Fastify from 'fastify';

const app = Fastify({ logger: true });
const port = Number(process.env.PORT || 3000);

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
