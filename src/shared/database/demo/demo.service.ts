import argon2 from 'argon2';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { TenantDb } from '../db.js';
import { assertLocalDemoDatabase, demoCalendar, demoOptionsSchema, type DemoOptions } from './demo.config.js';
import { loadDemoMigrations } from './demo-migrations.js';
import { DemoRepository } from './demo.repository.js';
import { seedDemo } from './demo.seed.js';

export async function provisionDemo(input: DemoOptions, databaseUrl: string, password: string) {
  const options = demoOptionsSchema.parse(input);
  assertLocalDemoDatabase(databaseUrl, process.env.NODE_ENV);
  if (password.length < 16) throw new Error('DEMO_PASSWORD_TOO_SHORT');
  const schemaName = `school_${options.name}`;
  const migrations = await loadDemoMigrations(schemaName);
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const passwordHash = await argon2.hash(password);
    const calendar = demoCalendar(new Date().toISOString().slice(0, 10));
    return await drizzle(pool).transaction(async (tx) => {
      const repo = new DemoRepository(tx as unknown as TenantDb);
      const tenantId = await repo.reserve(options);
      await repo.migrate(schemaName, migrations);
      await repo.verifyConductMigration();
      const directorId = await repo.insert('users', { role: 'director', name: 'Direction Démo',
        email: 'direction@demo.example', phone: '2250700000999', password_hash: passwordHash,
        ...(options.type === 'seeded' ? { created_at: calendar.start } : {}) });
      const seeded = options.type === 'seeded'
        ? await seedDemo(repo, directorId, passwordHash, calendar) : null;
      await repo.configureTenant(tenantId, !!seeded, seeded ? calendar.label : undefined);
      const counts = await repo.verify(!!seeded);
      return { tenantId, schemaName, subdomain: options.name.replaceAll('_', '-'), type: options.type,
        directorId, director: 'direction@demo.example', calendar: seeded ? calendar : null, seeded, counts };
    });
  } finally {
    await pool.end();
  }
}
