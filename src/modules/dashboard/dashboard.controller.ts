import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { withTenantSchema } from '../../shared/database/db.js';
import { requireDirectorOrSecretary } from '../../shared/middleware/auth.middleware.js';

import { buildDashboardService } from './dashboard.service.js';
import { dashboardPilotageQuerySchema, dashboardStatsQuerySchema } from './dashboard.types.js';

const handleError = (
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown
): FastifyReply => {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: 'Validation error',
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
  }

  request.log.error(
    { err: error instanceof Error ? error.message : 'unknown error' },
    '[dashboard] unhandled error'
  );

  return reply.code(500).send({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
    statusCode: 500,
  });
};

export default async function dashboardController(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/v1/dashboard/stats
   * Retourne les 4 KPI cards du dashboard : présence profs, présence élèves, salaires, abonnements.
   * Accessible au directeur ET au staff : le filtrage par carte (ex. masquage du
   * montant salaire) est appliqué côté front selon les permissions du staff.
   */
  app.get(
    '/api/v1/dashboard/stats',
    { preHandler: requireDirectorOrSecretary },
    async (request, reply) => {
    try {
      const claims = request.claims!;
      const query = dashboardStatsQuerySchema.parse(request.query ?? {});

      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildDashboardService(tenantDb);
        return service.getStats(query.date, query.month);
      });

      return reply.code(200).send(result);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.get(
    '/api/v1/dashboard/pilotage',
    { preHandler: requireDirectorOrSecretary },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const query = dashboardPilotageQuerySchema.parse(request.query ?? {});
        const result = await withTenantSchema(claims.schemaName, (tenantDb) =>
          buildDashboardService(tenantDb).getPilotageOverview(query.schoolYearId, query.gradingPeriodId)
        );
        return reply.code(200).send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );
}
