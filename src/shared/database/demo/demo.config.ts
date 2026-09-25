import { parseArgs } from 'node:util';
import { z } from 'zod';

export const demoOptionsSchema = z.object({
  name: z.string().regex(/^demo_[a-z0-9]+(?:_[a-z0-9]+)*$/).max(56),
  type: z.enum(['seeded', 'empty']),
});
export type DemoOptions = z.infer<typeof demoOptionsSchema>;

export function parseDemoOptions(args: string[]): DemoOptions {
  const { values } = parseArgs({ args, options: { name: { type: 'string' }, type: { type: 'string' } } });
  return demoOptionsSchema.parse(values);
}

export function assertLocalDemoDatabase(databaseUrl: string, nodeEnv?: string): void {
  const url = new URL(databaseUrl);
  if (nodeEnv === 'production' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || !['postgres:', 'postgresql:'].includes(url.protocol) || url.search) {
    throw new Error('DEMO_LOCAL_ONLY: connexion PostgreSQL locale sans paramètres requise ; production interdite.');
  }
}

export function shiftDate(date: string, days: number): string {
  return new Date(new Date(`${date}T12:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/** Calendrier glissant explicite : deuxième semaine de T3 le jour de création. */
export function demoCalendar(today: string) {
  const start = shiftDate(today, -203);
  const end = shiftDate(today, 77);
  return {
    today, start, end, review: shiftDate(end, -30),
    label: `${start.slice(5, 7)}/${start.slice(0, 4)} - ${end.slice(5, 7)}/${end.slice(0, 4)}`,
    periods: [
      { label: 'Trimestre 1', start, end: shiftDate(today, -119) },
      { label: 'Trimestre 2', start: shiftDate(today, -105), end: shiftDate(today, -15) },
      { label: 'Trimestre 3', start: shiftDate(today, -10), end },
    ],
  };
}
export type DemoCalendar = ReturnType<typeof demoCalendar>;
