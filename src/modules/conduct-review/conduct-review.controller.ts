import type { FastifyInstance } from 'fastify';
import { withTenantSchema } from '../../shared/database/db.js';
import { authenticateRequest } from '../../shared/middleware/auth.middleware.js';
import { buildConductReviewService } from './conduct-review.service.js';

export default async function conductReviewController(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/conduct/review-workspace', { preHandler: authenticateRequest }, async (request, reply) => {
    try {
      const result = await withTenantSchema(request.claims!.schemaName, (db) =>
        buildConductReviewService(db).getWorkspace({
          userId: request.user!.userId,
          canFinalize: request.permissions?.has('conduct.finalize') === true,
        }));
      return reply.send(result);
    } catch (error) {
      request.log.error({ err: error }, '[conduct-review] Workspace error');
      return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR', statusCode: 500 });
    }
  });

}
