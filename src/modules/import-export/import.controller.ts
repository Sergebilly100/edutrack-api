import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';

import { requirePermission } from '../../shared/middleware/auth.middleware.js';
import type { PermissionKey } from '../../shared/types/index.js';
import {
  attachTenantDb,
  releaseTenantDb,
} from '../../shared/middleware/tenant.middleware.js';

import { ImportModuleError, buildImportService } from './import.service.js';
import { importTypeParamsSchema, type ImportType } from './import.types.js';

const reportHasConflicts = (report: { conflicts?: unknown[] }): boolean => {
  return Array.isArray(report.conflicts) && report.conflicts.length > 0;
};

const handleError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: 'Validation error',
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
  }

  if (error instanceof ImportModuleError) {
    return reply.code(error.statusCode).send({
      error: error.message,
      code: error.code,
      statusCode: error.statusCode,
      details: error.details ?? null,
    });
  }

  return reply.code(500).send({
    error: 'Unexpected error',
    code: 'INTERNAL_SERVER_ERROR',
    statusCode: 500,
  });
};

const importRequestOptionsSchema = z.object({
  mode: z.enum(['merge', 'replace']).default('merge'),
  week_start: z.string().optional(),
  week_end: z.string().optional(),
  conflict_acknowledged: z
    .union([z.string(), z.boolean(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined) return false;
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return value === 1;
      return value.toLowerCase() === 'true' || value === '1' || value.toLowerCase() === 'yes';
    }),
});

const readImportPayload = async (
  request: FastifyRequest
): Promise<{
  fileBuffer: Buffer;
  mode: 'merge' | 'replace';
  schedulePeriod?: { weekStart: string; weekEnd: string };
  conflictAcknowledged: boolean;
}> => {
  const fields: Record<string, string | boolean | number> = {};
  let fileBuffer: Buffer | null = null;

  const parts = request.parts();
  for await (const part of parts) {
    if (part.type === 'file') {
      if (!part.file) {
        continue;
      }
      fileBuffer = await part.toBuffer();
      continue;
    }
    fields[part.fieldname] = String(part.value ?? '');
  }

  if (!fileBuffer) {
    throw new ImportModuleError('Fichier manquant', 400, 'IMPORT_FILE_REQUIRED');
  }

  const parsed = importRequestOptionsSchema.parse(fields);
  const hasPeriod = typeof parsed.week_start === 'string' && typeof parsed.week_end === 'string';
  const schedulePeriod = hasPeriod
    ? {
        weekStart: parsed.week_start as string,
        weekEnd: parsed.week_end as string,
      }
    : undefined;

  return {
    fileBuffer,
    mode: parsed.mode,
    schedulePeriod,
    conflictAcknowledged: parsed.conflict_acknowledged,
  };
};

const ensureTenantDb = (request: FastifyRequest) => {
  if (!request.db) {
    throw new ImportModuleError('Tenant database not initialized', 500, 'IMPORT_DB_NOT_INITIALIZED');
  }

  return request.db;
};

const importHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const IMPORT_PERMISSION_BY_TYPE: Readonly<Record<ImportType, PermissionKey>> = {
  students: 'import.students',
  teachers: 'import.teachers',
  schedule: 'import.schedule',
};

const requireImportTypePermission = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => {
  const { type } = importTypeParamsSchema.parse(request.params ?? {});
  const permission = IMPORT_PERMISSION_BY_TYPE[type];
  await requirePermission(permission)(request, reply);
};

export default async function importExportController(app: FastifyInstance): Promise<void> {
  app.addHook('onResponse', async (request) => {
    await releaseTenantDb(request);
  });

  app.get(
    '/api/v1/import/:type/template',
    { preHandler: [requireImportTypePermission, attachTenantDb] },
    async (request, reply) => {
      try {
        const { type } = importTypeParamsSchema.parse(request.params ?? {});
        const templatePath = path.resolve(process.cwd(), 'templates', `${type}.xlsx`);

        if (!existsSync(templatePath)) {
          return reply.code(404).send({
            error: 'Template not found',
            code: 'TEMPLATE_NOT_FOUND',
            statusCode: 404,
          });
        }

        reply
          .header(
            'Content-Disposition',
            `attachment; filename="edutrack-import-${type}-template.xlsx"`
          )
          .type(
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          );

        return reply.send(createReadStream(templatePath));
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.post(
    '/api/v1/import/:type/dry-run',
    { preHandler: [requireImportTypePermission, attachTenantDb] },
    async (request, reply) => {
      try {
        const { type } = importTypeParamsSchema.parse(request.params ?? {});
        const payload = await readImportPayload(request);
        const service = buildImportService();
        const report = await service.dryRun(type, payload.fileBuffer, ensureTenantDb(request), {
          mode: payload.mode,
          schedulePeriod: payload.schedulePeriod,
        });

        return reply.send(report);
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.post(
    '/api/v1/import/:type/confirm',
    { preHandler: [requireImportTypePermission, attachTenantDb] },
    async (request, reply) => {
      try {
        const { type } = importTypeParamsSchema.parse(request.params ?? {});
        const payload = await readImportPayload(request);
        const tenantDb = ensureTenantDb(request);
        const service = buildImportService();
        if (
          type === 'schedule' &&
          reportHasConflicts(
            await service.dryRun(type, payload.fileBuffer, tenantDb, {
              mode: payload.mode,
              schedulePeriod: payload.schedulePeriod,
            })
          ) &&
          !payload.conflictAcknowledged
        ) {
          throw new ImportModuleError(
            'Conflits EDT détectés. Merci de confirmer le remplacement.',
            400,
            'IMPORT_CONFLICT_ACK_REQUIRED'
          );
        }

        const report = await service.confirm(type, payload.fileBuffer, tenantDb, {
          mode: payload.mode,
          schedulePeriod: payload.schedulePeriod,
        });

        return reply.send(report);
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.get(
    '/api/v1/import/history',
    { preHandler: [requirePermission('import.students'), attachTenantDb] },
    async (request, reply) => {
      try {
        const { limit } = importHistoryQuerySchema.parse(request.query ?? {});
        const service = buildImportService();
        const items = await service.listHistory(ensureTenantDb(request), limit);
        return reply.send({ items });
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );
}
