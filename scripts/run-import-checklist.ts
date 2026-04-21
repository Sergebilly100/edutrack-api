import { readFileSync } from 'node:fs';
import path from 'node:path';

import { sql } from 'drizzle-orm';

import { withTenantSchema } from '../src/shared/database/db.ts';
import { buildImportService } from '../src/modules/import-export/import.service.ts';

type ImportKind = 'teachers' | 'students' | 'schedule';

type SprintConfig = {
  name: string;
  files: Record<ImportKind, string>;
  schedulePeriod: { weekStart: string; weekEnd: string };
};

type SchoolConfig = {
  school: string;
  schema: string;
  sprints: SprintConfig[];
  autoRoomChecks: Array<{ name: string; building: string; capacity: number }>;
};

const BASE = path.resolve('../archives/import-tests');

const CONFIG: SchoolConfig[] = [
  {
    school: 'Lycee-Sainte-Marie',
    schema: 'school_sainte_marie',
    sprints: [
      {
        name: 'sprint1',
        files: {
          teachers: 'Lycee-Sainte-Marie-sprint1-teachers.xlsx',
          students: 'Lycee-Sainte-Marie-sprint1-students.xlsx',
          schedule: 'Lycee-Sainte-Marie-sprint1-schedule.xlsx',
        },
        schedulePeriod: { weekStart: '2026-09-07', weekEnd: '2026-09-07' },
      },
      {
        name: 'sprint2',
        files: {
          teachers: 'Lycee-Sainte-Marie-sprint2-teachers.xlsx',
          students: 'Lycee-Sainte-Marie-sprint2-students.xlsx',
          schedule: 'Lycee-Sainte-Marie-sprint2-schedule.xlsx',
        },
        schedulePeriod: { weekStart: '2026-10-05', weekEnd: '2026-10-05' },
      },
    ],
    autoRoomChecks: [
      { name: 'Salle 09', building: 'Batiment D', capacity: 42 },
      { name: 'Salle 10', building: 'Batiment D', capacity: 40 },
    ],
  },
  {
    school: 'Universite-Horizon',
    schema: 'school_universite_horizon',
    sprints: [
      {
        name: 'sprint1',
        files: {
          teachers: 'Universite-Horizon-sprint1-teachers.xlsx',
          students: 'Universite-Horizon-sprint1-students.xlsx',
          schedule: 'Universite-Horizon-sprint1-schedule.xlsx',
        },
        schedulePeriod: { weekStart: '2026-09-07', weekEnd: '2026-09-07' },
      },
      {
        name: 'sprint2',
        files: {
          teachers: 'Universite-Horizon-sprint2-teachers.xlsx',
          students: 'Universite-Horizon-sprint2-students.xlsx',
          schedule: 'Universite-Horizon-sprint2-schedule.xlsx',
        },
        schedulePeriod: { weekStart: '2026-10-05', weekEnd: '2026-10-05' },
      },
    ],
    autoRoomChecks: [
      { name: 'Salle TP 3', building: 'Bloc TP', capacity: 45 },
      { name: 'Salle C201', building: 'Bloc C', capacity: 50 },
      { name: 'Amphi C', building: 'Bloc Principal', capacity: 140 },
    ],
  },
];

const service = buildImportService();

const run = async (): Promise<void> => {
  process.env.IMPORT_TEACHER_DEFAULT_PASSWORD ??= 'TempPass123!';
  const report: unknown[] = [];

  for (const school of CONFIG) {
    const schoolResult = await withTenantSchema(school.schema, async (tenantDb) => {
      const sprintResults: unknown[] = [];

      for (const sprint of school.sprints) {
        const sprintResult: Record<string, unknown> = {
          sprint: sprint.name,
          steps: [],
        };

        for (const kind of ['teachers', 'students', 'schedule'] as const) {
          const filePath = path.join(BASE, sprint.files[kind]);
          const fileBuffer = readFileSync(filePath);

          const dryRun = await service.dryRun(kind, fileBuffer, tenantDb, {
            mode: 'merge',
            schedulePeriod: kind === 'schedule' ? sprint.schedulePeriod : undefined,
          });

          const confirm = await service.confirm(kind, fileBuffer, tenantDb, {
            mode: 'merge',
            schedulePeriod: kind === 'schedule' ? sprint.schedulePeriod : undefined,
          });

          const step = {
            type: kind,
            dryRun: {
              valid: dryRun.valid,
              errors: dryRun.errors.length,
            },
            confirm: {
              imported: confirm.imported,
              updated: confirm.updated,
              errors: confirm.errors.length,
            },
          };

          (sprintResult.steps as unknown[]).push(step);
        }

        sprintResults.push(sprintResult);
      }

      const roomChecks = [];
      for (const room of school.autoRoomChecks) {
        const roomResult = await tenantDb.execute(
          sql.raw(
            `SELECT name, building, capacity, is_active FROM rooms WHERE name='${room.name.replace(/'/g, "''")}' LIMIT 1`
          )
        );
        roomChecks.push({
          expected: room,
          actual: roomResult.rows[0] ?? null,
        });
      }

      const historyResult = await tenantDb.execute(
        sql.raw(
          `SELECT import_type, imported_count, updated_count, imported_at::text AS imported_at
           FROM import_history
           ORDER BY imported_at DESC
           LIMIT 8`
        )
      );

      return {
        school: school.school,
        schema: school.schema,
        sprintResults,
        autoRoomChecks: roomChecks,
        latestImportHistory: historyResult.rows,
      };
    });

    report.push(schoolResult);
  }

  console.log(JSON.stringify(report, null, 2));
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

