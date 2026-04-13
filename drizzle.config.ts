import 'dotenv/config';

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/shared/database/schema/',
  out: './src/shared/database/migrations/',
  dialect: 'postgresql',
  migrations: {
    table: 'drizzle_migrations',
    schema: 'public',
  },
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
