import { describe, expect, it } from 'vitest';
import { assertLocalDemoDatabase, demoCalendar, parseDemoOptions } from '../../src/shared/database/demo/demo.config.js';
import { loadDemoMigrations, scopeDemoMigration } from '../../src/shared/database/demo/demo-migrations.js';

describe('isolated demo guards', () => {
  it.each(['demo_t3', 'demo_client_2026'])('accepts a clearly labelled demo: %s', (name) => {
    expect(parseDemoOptions([`--name=${name}`, '--type=empty'])).toEqual({ name, type: 'empty' });
  });
  it.each(['sainte_marie', 'school_sainte_marie', 'demo_a;DROP', 'demo_', 'demo__a', 'demo_A', `demo_${'x'.repeat(52)}`])('rejects unsafe name %s', (name) => {
    expect(() => parseDemoOptions([`--name=${name}`, '--type=seeded'])).toThrow();
  });
  it('requires an explicit profile and rejects reset flags', () => {
    expect(() => parseDemoOptions(['--name=demo_a'])).toThrow();
    expect(() => parseDemoOptions(['--name=demo_a', '--type=empty', '--reset'])).toThrow();
  });
  it.each(['postgres://localhost/db', 'postgresql://127.0.0.1:5432/db', 'postgres://[::1]/db'])('allows loopback %s', (url) => {
    expect(() => assertLocalDemoDatabase(url, 'development')).not.toThrow();
  });
  it.each(['postgres://db.example/db', 'postgres://localhost.example/db', 'https://localhost/db', 'postgres://localhost/db?host=remote'])('rejects nonlocal or overridden connections %s', (url) => {
    expect(() => assertLocalDemoDatabase(url)).toThrow('DEMO_LOCAL_ONLY');
  });
  it('never accepts production, even on localhost', () => {
    expect(() => assertLocalDemoDatabase('postgres://localhost/db', 'production')).toThrow();
  });
  it.each(['2026-09-24', '2027-01-02', '2028-03-01'])('keeps a coherent early T3 calendar across boundaries: %s', (today) => {
    const calendar = demoCalendar(today);
    expect(calendar.start < today && calendar.end > today).toBe(true);
    expect(calendar.periods[0]!.reviewStart).toBe(calendar.periods[1]!.start);
    expect(calendar.periods[1]!.reviewStart).toBe(calendar.periods[2]!.start);
    expect(calendar.periods[0]!.end > calendar.periods[1]!.start).toBe(true);
    expect(calendar.periods[1]!.end > calendar.periods[2]!.start).toBe(true);
    expect(calendar.periods[2]!.start < today && calendar.review > today).toBe(true);
  });
  it('fails closed when migration content has changed', () => {
    expect(() => scopeDemoMigration('0001_glossy_quicksilver.sql', 'DROP SCHEMA public CASCADE', 'school_demo_a')).toThrow('REVIEW_REQUIRED');
  });
  it('loads only scoped migrations and excludes the legacy token backfill', async () => {
    const statements = await loadDemoMigrations('school_demo_guard');
    const source = statements.join('\n');
    expect(statements.length).toBeGreaterThan(300);
    expect(source).not.toMatch(/ALTER TABLE public\.|UPDATE "public"|nspname LIKE 'school_%'|table_schema NOT IN|n\.nspname NOT IN|digest\(token/);
    expect(source).not.toContain('"tenant"');
    expect(source).toContain("table_schema = 'school_demo_guard'");
    expect(source).toContain("nspname = 'school_demo_guard'");
  });
});
