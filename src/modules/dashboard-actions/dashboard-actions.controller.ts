import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';

import { withTenantSchema } from '../../shared/database/db.js';
import { authenticateRequest } from '../../shared/middleware/auth.middleware.js';
import type { PermissionKey } from '../../shared/types/index.js';
import { buildDashboardActionsService, DIRECTOR_ONLY_ACTION_TYPES } from './dashboard-actions.service.js';
import { refreshDashboardActionsForSchema } from './dashboard-actions.worker.js';

const forbidden = (reply: FastifyReply, message: string): FastifyReply =>
  reply.code(403).send({ error: message, code: 'FORBIDDEN', statusCode: 403 });

const requireAnyPermission =
  (permissions: readonly PermissionKey[]) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await authenticateRequest(request, reply);
    if (reply.sent) return;
    if (!permissions.some((permission) => request.permissions?.has(permission))) {
      forbidden(reply, `Permission ${permissions.join(' ou ')} required`);
      return;
    }
  };

const handleError = (
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown
): FastifyReply => {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: 'Invalid request',
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      details: error.issues,
    });
  }
  request.log.error({ err: error }, '[dashboard-actions] Unexpected error');
  return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR', statusCode: 500 });
};

const resolveParamsSchema = z.object({ id: z.string().uuid() });

export default async function dashboardActionsController(app: FastifyInstance): Promise<void> {
  // Contenu mixte (assiduité, salaires, validations, finances) : l'accès est
  // ouvert aux mêmes permissions que les cartes affichées.
  app.get(
    '/api/v1/dashboard/action-items',
    { preHandler: requireAnyPermission(['attendance.view', 'students.view', 'teachers.view', 'payments.view', 'validations.view']) },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        // Recalcul à la lecture : un échec n'empêche pas de servir la dernière liste connue.
        await refreshDashboardActionsForSchema(claims.schemaName).catch((error) =>
          request.log.warn({ err: error }, '[dashboard-actions] refresh on read failed'));
        const items = await withTenantSchema(claims.schemaName, async (tenantDb) =>
          buildDashboardActionsService(tenantDb).listOpen()
        );
        // Configuration et décisions de conduite : visibles uniquement du directeur.
        const visible = request.claims?.role === 'director'
          ? items
          : items.filter((item) => !DIRECTOR_ONLY_ACTION_TYPES.includes(item.type));
        return reply.send({ items: visible });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.post(
    '/api/v1/dashboard/action-items/:id/resolve',
    { preHandler: requireAnyPermission(['attendance.view', 'students.view', 'teachers.view', 'payments.view', 'validations.view']) },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const params = resolveParamsSchema.parse(request.params ?? {});
        const resolved = await withTenantSchema(claims.schemaName, async (tenantDb) =>
          buildDashboardActionsService(tenantDb).resolve(params.id, request.user!.userId)
        );
        return reply.send({ resolved });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );
}
