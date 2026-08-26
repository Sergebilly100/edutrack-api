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
import { RiskRepository } from './risk.repository.js';
import { riskRuleUpsertSchema } from './risk.types.js';

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
        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          const repository = new RiskRepository(tenantDb);
          const rows = (await repository.listStudentRisks()) as Array<Record<string, unknown>>;
          // Alignement permission ↔ affichage : les enseignants ne voient que
          // leurs propres élèves (prof principal), jamais l'école entière.
          if (claims.role === 'teacher') {
            const homeroomIds = await repository.listHomeroomStudentIds(request.user!.userId);
            const allowed = homeroomIds ?? [];
            return rows.filter((row) => allowed.includes(String(row.student_id)));
          }
          return rows;
        });
        return reply.send({ students: result });
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
        const result = await withTenantSchema(claims.schemaName, async (tenantDb) =>
          new RiskRepository(tenantDb).listTeacherRisks()
        );
        return reply.send({ teachers: result });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get(
    '/api/v1/risk/rules',
    { preHandler: requirePermission('students.view') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const rules = await withTenantSchema(claims.schemaName, async (tenantDb) =>
          new RiskRepository(tenantDb).listRules()
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
        const body = riskRuleUpsertSchema.parse(request.body ?? {});
        await withTenantSchema(claims.schemaName, async (tenantDb) =>
          new RiskRepository(tenantDb).upsertRule({
            subjectType: params.subjectType,
            signalType: params.signalType,
            thresholdValue: body.thresholdValue,
            periodDays: body.periodDays,
            isActive: body.isActive,
          })
        );
        return reply.send({ success: true });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );
}
