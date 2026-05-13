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
      // Use the first file encountered; ignore subsequent ones
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
  page: z.coerce.number().int().min(1).default(1),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  type: z.enum(['students', 'teachers', 'schedule']).optional(),
});

const IMPORT_PERMISSION_BY_TYPE: Readonly<Record<ImportType, PermissionKey>> = {
  students: 'import.students',
  teachers: 'import.teachers',
  schedule: 'import.schedule',
};

// Returns true if the authenticated user has at least one import permission
const hasAnyImportPermission = (request: FastifyRequest): boolean => {
  const perms = request.permissions;
  if (!perms) return false;
  return (
    perms.has('import.students') ||
    perms.has('import.teachers') ||
    perms.has('import.schedule')
  );
};

const requireImportTypePermission = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => {
  const { type } = importTypeParamsSchema.parse(request.params ?? {});
  const permission = IMPORT_PERMISSION_BY_TYPE[type];
  await requirePermission(permission)(request, reply);
};

// Authenticates and grants access if the user holds any import permission.
// Uses requirePermission('import.students') to handle auth, then broadens the check.
const requireAnyImportPermission = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => {
  // authenticateRequest is called inside requirePermission — reuse it to populate
  // request.permissions without sending a 403 for the specific permission yet.
  const { authenticateRequest } = await import('../../shared/middleware/auth.middleware.js');
  await authenticateRequest(request, reply);
  if (reply.sent) return;

  if (!hasAnyImportPermission(request)) {
    reply.code(403).send({
      error: 'Permission import required',
      code: 'FORBIDDEN',
      statusCode: 403,
    });
  }
};

const getTenantContext = (
  request: FastifyRequest
): { tenantId: string; schemaName: string; actorUserId: string; actorRole: string } | undefined => {
  const claims = request.claims;
  if (!claims?.schemaName) return undefined;
  return {
    tenantId: claims.tenantId ?? '',
    schemaName: claims.schemaName,
    actorUserId: claims.sub,
    actorRole: claims.role,
  };
};

export default async function importExportController(app: FastifyInstance): Promise<void> {
  app.addHook('onResponse', async (request) => {
    await releaseTenantDb(request);
  });

  // ce endpoint permet de télécharger un template Excel pour le type d'import spécifié (students, teachers, schedule). 
  // Le template est stocké dans le dossier "templates" à la racine du projet et doit être nommé selon le format "{type}.xlsx". Seuls les utilisateurs ayant la permission d'import correspondante peuvent accéder au template. Si le template n'existe pas, une erreur 404 est retournée.
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

  // ce endpoint gère à la fois les imports de données (students, teachers) et d'emploi du temps, d'où la logique plus complexe pour les options spécifiques à l'emploi du temps
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

  // ce endpoint finalise l'import après un dry-run, en appliquant les changements et en enregistrant un rapport d'import dans l'historique.
  // la confirmation d'import est nécessaire pour les imports de planning, afin de s'assurer que l'utilisateur a bien pris connaissance des conflits potentiels détectés lors du dry-run.
  app.post(
    '/api/v1/import/:type/confirm',
    { preHandler: [requireImportTypePermission, attachTenantDb] },
    async (request, reply) => {
      try {
        const { type } = importTypeParamsSchema.parse(request.params ?? {});
        const payload = await readImportPayload(request);
        const service = buildImportService();

        // c'est ici que la logique de confirmation d'import devient cruciale, notamment pour les imports de planning où des conflits peuvent survenir. 
        // Le service doit vérifier que l'utilisateur a bien reconnu les conflits avant de procéder à l'import effectif.
        const report = await service.confirm(type, payload.fileBuffer, ensureTenantDb(request), {
          mode: payload.mode,
          schedulePeriod: payload.schedulePeriod,
          conflictAcknowledged: payload.conflictAcknowledged,
          tenantContext: getTenantContext(request),
        });

        return reply.send(report);
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  // ce endpoint permet de consulter l'historique des imports effectués, avec pagination et filtres optionnels par mois et type d'import. L'accès est accordé à tout utilisateur ayant au moins une permission d'import, et les résultats affichent les imports de tous les types confondus pour le tenant.
  app.get(
    '/api/v1/import/history',
    // Any user with at least one import permission can view the shared history.
    { preHandler: [requireAnyImportPermission, attachTenantDb] },
    async (request, reply) => {
      try {
        const { limit, page, month, type } = importHistoryQuerySchema.parse(request.query ?? {});
        const service = buildImportService();
        const result = await service.listHistory(ensureTenantDb(request), { limit, page, month, type });
        return reply.send(result);
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );
}
