import { sql } from 'drizzle-orm';

import { createTenantSchema } from '../src/shared/database/tenant-init.ts';
import { withTenantSchema } from '../src/shared/database/db.ts';

const SCHOOL_SETUP = [
  {
    schema: 'school_sainte_marie',
    classes: ['6eme A', '3eme A', 'Tle C', '2nde A', 'Tle D'],
    timeSlots: [
      { label: '7h30 - 9h00', start: '07:30', end: '09:00', sort: 1 },
      { label: '9h00 - 10h30', start: '09:00', end: '10:30', sort: 2 },
      { label: '10h30 - 12h00', start: '10:30', end: '12:00', sort: 3 },
      { label: '13h30 - 15h00', start: '13:30', end: '15:00', sort: 4 },
      { label: '15h00 - 16h30', start: '15:00', end: '16:30', sort: 5 },
    ],
  },
  {
    schema: 'school_universite_horizon',
    classes: ['L1 INFO A', 'L1 INFO B', 'L2 INFO A', 'L2 GESTION A', 'L3 INFO A', 'L3 GESTION A'],
    timeSlots: [
      { label: '7h30 - 9h00', start: '07:30', end: '09:00', sort: 1 },
      { label: '9h00 - 10h30', start: '09:00', end: '10:30', sort: 2 },
      { label: '10h30 - 12h00', start: '10:30', end: '12:00', sort: 3 },
      { label: '13h30 - 15h00', start: '13:30', end: '15:00', sort: 4 },
      { label: '15h00 - 16h30', start: '15:00', end: '16:30', sort: 5 },
    ],
  },
] as const;

const run = async (): Promise<void> => {
  for (const school of SCHOOL_SETUP) {
    await createTenantSchema(school.schema);

    await withTenantSchema(school.schema, async (tenantDb) => {
      for (const klass of school.classes) {
        await tenantDb.execute(
          sql.raw(
            `INSERT INTO classes (name, level, student_count)
             SELECT '${klass.replace(/'/g, "''")}', NULL, 0
             WHERE NOT EXISTS (
               SELECT 1 FROM classes WHERE LOWER(name) = LOWER('${klass.replace(/'/g, "''")}')
             )`
          )
        );
      }

      for (const slot of school.timeSlots) {
        await tenantDb.execute(
          sql.raw(
            `INSERT INTO time_slots (label, start_time, end_time, sort_order)
             VALUES ('${slot.label.replace(/'/g, "''")}', '${slot.start}', '${slot.end}', ${slot.sort})
             ON CONFLICT (label) DO NOTHING`
          )
        );
      }
    });
  }

  console.log('Import test environment is ready for both schools.');
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

