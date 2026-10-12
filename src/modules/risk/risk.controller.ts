import { dateValidationProblem } from '../../shared/utils/date-validation.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { withTenantSchema } from '../../shared/database/db.js';
import { authenticateRequest, requirePermission } from '../../shared/middleware/auth.middleware.js';
import type { PermissionKey } from '../../shared/types/index.js';
import { z } from 'zod';

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
import { buildRiskService } from './risk.service.js';
import { riskRuleUpsertSchema, teacherLatenessRuleUpsertSchema, riskStudentsQuerySchema, riskTeachersQuerySchema } from './risk.types.js';

const handleError = (
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown
): FastifyReply => {
  if (error instanceof ZodError) {
    const dateProblem = dateValidationProblem(error);
    if (dateProblem) return reply.code(400).send(dateProblem);
    return reply.code(400).send({
      error: 'Invalid request',
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      details: error.issues,
    });
  }
  request.log.error({ err: error }, '[risk] Unexpected error');
  return reply.code(500).send({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
    statusCode: 500,
  });
};

export default async function riskController(app: FastifyInstance): Promise<void> {
  // Élèves à risque. Direction/staff : tous ; prof principal : sa classe.
  app.get(
    '/api/v1/risk/students',
    { preHandler: requireAnyPermission(['students.view', 'attendance.view']) },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const query = riskStudentsQuerySchema.parse(request.query);
        const result = await withTenantSchema(claims.schemaName, async (tenantDb) =>
          buildRiskService(tenantDb).listStudentRisks({
            ...query,
            includePayments: request.permissions?.has('payments.view') ?? false,
            homeroomUserId: claims.role === 'teacher' ? request.user!.userId : undefined,
          })
        );
        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  // Profs à risque : même permission métier que l'affichage existant.
  app.get(
    '/api/v1/risk/teachers',
    { preHandler: requireAnyPermission(['teachers.view', 'attendance.view']) },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const query = riskTeachersQuerySchema.parse(request.query);
        const result = await withTenantSchema(claims.schemaName, async (tenantDb) =>
          buildRiskService(tenantDb).listTeacherRisks(query)
        );
        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get(
    '/api/v1/risk/rules',
    { preHandler: requirePermission('risk_alerts.edit') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const rules = await withTenantSchema(claims.schemaName, async (tenantDb) =>
          buildRiskService(tenantDb).listRules()
        );
        return reply.send({ rules });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.put(
    '/api/v1/risk/rules/:subjectType/:signalType',
    { preHandler: requirePermission('risk_alerts.edit') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const params = z
          .object({ subjectType: z.enum(['student', 'teacher']), signalType: z.string().min(1) })
          .parse(request.params);
        const schema = params.subjectType === 'teacher' && params.signalType === 'lateness'
          ? teacherLatenessRuleUpsertSchema : riskRuleUpsertSchema;
        const body = schema.parse(request.body ?? {});
        await withTenantSchema(claims.schemaName, async (tenantDb) =>
          buildRiskService(tenantDb).upsertRule({
            subjectType: params.subjectType,
            signalType: params.signalType,
            thresholdValue: body.thresholdValue,
            periodDays: body.periodDays,
            isActive: body.isActive,
            lateMinutes: body.lateMinutes,
          })
        );
        return reply.send({ success: true });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );
}
