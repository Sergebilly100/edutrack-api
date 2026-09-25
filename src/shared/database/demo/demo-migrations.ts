import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import manifest from './migrations.manifest.json' with { type: 'json' };

const migrationsFolder = new URL('../migrations/', import.meta.url);
const reviewed: Record<string, string> = manifest;

/** Reuse the checked-in Drizzle migrations, never the all-tenant bootstrap.
 * Hashes make new/changed migrations fail closed until their scope is reviewed.
 * The five retained historical global loops are restricted to the one new schema.
 */
export function scopeDemoMigration(filename: string, content: string, schema: string): string[] {
  if (!/^school_demo_[a-z0-9_]+$/.test(schema) || schema.length > 63) throw new Error('DEMO_INVALID_SCHEMA');
  if (createHash('sha256').update(content).digest('hex') !== reviewed[filename]) {
    throw new Error(`DEMO_MIGRATION_REVIEW_REQUIRED: ${filename}`);
  }
  if (filename.startsWith('0000_') || filename.startsWith('0011_')) return [];
  let source = content;
  const globalLoop = /^(0010_|0012_|0013_|0032_|0047_)/.test(filename);
  if (globalLoop) {
    source = source.replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', '')
      .replace("n.nspname NOT IN ('pg_catalog', 'information_schema')", `n.nspname = '${schema}'`)
      .replace("table_schema NOT IN ('pg_catalog', 'information_schema')", `table_schema = '${schema}'`)
      .replace("nspname LIKE 'school_%'", `nspname = '${schema}'`);
    if (!source.includes(`= '${schema}'`)) throw new Error(`DEMO_UNSCOPED_LOOP: ${filename}`);
  }
  // This historical file interleaves public DDL and tenant DDL without breakpoints.
  if (filename === '0027_attendance_validations.sql') {
    source = source.replace(/ALTER TABLE public\.school_sms_features[^;]+;/g, '');
  }
  return source.split('--> statement-breakpoint').flatMap((chunk) => {
    if (!globalLoop && !chunk.includes('"tenant"')) return [];
    if (/\bpublic\s*[".]|\bschool_%/.test(chunk)) throw new Error(`DEMO_UNSCOPED_SQL: ${filename}`);
    return [chunk.replaceAll('"tenant"', `"${schema}"`)
      .replace(/nspname\s*=\s*'tenant'/g, `nspname = '${schema}'`).trim()];
  }).filter(Boolean);
}

export async function loadDemoMigrations(schema: string): Promise<string[]> {
  const files = (await readdir(migrationsFolder)).filter((name) => name.endsWith('.sql')).sort();
  if (files.join('|') !== Object.keys(reviewed).sort().join('|')) throw new Error('DEMO_MIGRATION_REVIEW_REQUIRED');
  const result: string[] = [];
  for (const file of files) result.push(...scopeDemoMigration(file, await readFile(new URL(file, migrationsFolder), 'utf8'), schema));
  return result;
}
