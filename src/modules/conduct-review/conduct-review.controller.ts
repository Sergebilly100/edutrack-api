import type { FastifyInstance } from 'fastify';
import { withTenantSchema } from '../../shared/database/db.js';
import { withReadyConductTenant } from '../../shared/database/conduct-ready.js';
import { authenticateRequest } from '../../shared/middleware/auth.middleware.js';
import { buildConductReviewService } from './conduct-review.service.js';
import { isMissingConductMigration } from '../../shared/database/conduct-migration-contract.js';

export default async function conductReviewController(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/conduct/teacher-actions', { preHandler: authenticateRequest }, async (request, reply) => {
    try {
      const result = await withTenantSchema(request.claims!.schemaName, (db) =>
        buildConductReviewService(db).getTeacherActions(request.user!.userId));
      return reply.send(result);
    } catch (error) {
      request.log.error({ err: error }, '[conduct-review] Teacher actions error');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR', statusCode: 500 });
    }
  });

  app.get('/api/v1/conduct/decision-workspace', { preHandler: authenticateRequest }, async (request, reply) => {
    try {
      const result = await withReadyConductTenant(request.claims!.schemaName, (db) =>
        buildConductReviewService(db).getDecisionWorkspace({
          userId: request.user!.userId,
          canFinalize: request.permissions?.has('conduct.finalize') === true,
        }));
      return reply.send(result);
    } catch (error) {
      request.log.error({ err: error }, '[conduct-review] Decision workspace error');
      if (isMissingConductMigration(error)) {
        return reply.code(503).send({ error: 'Migration de conduite requise pour cette école', code: 'CONDUCT_MIGRATION_REQUIRED', statusCode: 503 });
      }
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR', statusCode: 500 });
    }
  });

  // Compatibility for clients deployed before C29. Reads are never run in parallel:
  // a policy failure cannot prevent a teacher from receiving opinion actions.
  app.get('/api/v1/conduct/review-workspace', { preHandler: authenticateRequest }, async (request, reply) => {
    const schema = request.claims!.schemaName;
    const userId = request.user!.userId;
    const context = { userId, canFinalize: request.permissions?.has('conduct.finalize') === true };
    try {
      if (request.claims!.role === 'teacher') {
        const { teacherActions } = await withTenantSchema(schema, (db) =>
          buildConductReviewService(db).getTeacherActions(userId));
        try {
          const decisions = await withReadyConductTenant(schema, (db) =>
            buildConductReviewService(db).getDecisionWorkspace(context));
          return reply.send({ teacherActions, ...decisions });
        } catch (error) {
          request.log.error({ err: error }, '[conduct-review] Legacy decision read error');
          return reply.send({ teacherActions, decisionScopes: [], decisionActions: [],
            decisionError: { code: isMissingConductMigration(error) ? 'CONDUCT_MIGRATION_REQUIRED' : 'INTERNAL_ERROR' } });
        }
      }
      const decisions = await withReadyConductTenant(schema, (db) =>
        buildConductReviewService(db).getDecisionWorkspace(context));
      return reply.send({ teacherActions: [], ...decisions });
    } catch (error) {
      request.log.error({ err: error }, '[conduct-review] Legacy workspace error');
      if (isMissingConductMigration(error)) {
        return reply.code(503).send({ error: 'Migration de conduite requise pour cette école', code: 'CONDUCT_MIGRATION_REQUIRED', statusCode: 503 });
      }
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR', statusCode: 500 });
    }
  });

}
