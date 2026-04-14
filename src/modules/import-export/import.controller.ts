import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';

import { requireDirectorOrSecretary } from '../../shared/middleware/auth.middleware.js';
import {
  attachTenantDb,
  releaseTenantDb,
} from '../../shared/middleware/tenant.middleware.js';

import { ImportModuleError, buildImportService } from './import.service.js';
import { importTypeParamsSchema } from './import.types.js';

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

const readUploadBuffer = async (request: FastifyRequest): Promise<Buffer> => {
  const file = await request.file();
  if (!file) {
    throw new ImportModuleError('Fichier manquant', 400, 'IMPORT_FILE_REQUIRED');
  }

  return file.toBuffer();
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

export default async function importExportController(app: FastifyInstance): Promise<void> {
  app.addHook('onResponse', async (request) => {
    await releaseTenantDb(request);
  });

  app.get(
    '/api/v1/import/:type/template',
    { preHandler: [requireDirectorOrSecretary, attachTenantDb] },
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
    { preHandler: [requireDirectorOrSecretary, attachTenantDb] },
    async (request, reply) => {
      try {
        const { type } = importTypeParamsSchema.parse(request.params ?? {});
        const fileBuffer = await readUploadBuffer(request);
        const service = buildImportService();
        const report = await service.dryRun(type, fileBuffer, ensureTenantDb(request));

        return reply.send(report);
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.post(
    '/api/v1/import/:type/confirm',
    { preHandler: [requireDirectorOrSecretary, attachTenantDb] },
    async (request, reply) => {
      try {
        const { type } = importTypeParamsSchema.parse(request.params ?? {});
        const fileBuffer = await readUploadBuffer(request);
        const service = buildImportService();
        const report = await service.confirm(type, fileBuffer, ensureTenantDb(request));

        return reply.send(report);
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.get(
    '/api/v1/import/history',
    { preHandler: [requireDirectorOrSecretary, attachTenantDb] },
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
