import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';

import { withTenantSchema } from '../../shared/database/db.js';
import { requireDirector } from '../../shared/middleware/auth.middleware.js';
import { buildDashboardRepository } from '../dashboard/dashboard.repository.js';

const monthQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional()
    .default(() => new Date().toISOString().slice(0, 7)),
});

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
    '[salaries-summary] unhandled error'
  );

  return reply.code(500).send({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
    statusCode: 500,
  });
};

export async function registerSalariesSummaryRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/v1/salaries/summary
   * Retourne les 4 KPI cards de la page Salaires
   */
  app.get('/api/v1/salaries/summary', { preHandler: requireDirector }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const query = monthQuerySchema.parse(request.query ?? {});
      const currentDate = new Date().toISOString().slice(0, 10);

      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const repository = buildDashboardRepository(tenantDb);

        const [salaryStats, teacherAttendance] = await Promise.all([
          repository.getSalaryStatsForMonth(query.month, currentDate),
          repository.getTeacherAttendanceForMonth(query.month, currentDate),
        ]);

        return {
          totalToPay: salaryStats.monthlyTotal,
          totalPaid: salaryStats.toPayCurrentPeriod,
          economy: salaryStats.economy,
          teacherAttendance,
        };
      });

      return reply.code(200).send(result);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });
}
