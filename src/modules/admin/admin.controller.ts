import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import {
  createTenantBodySchema,
  listTenantsQuerySchema,
  tenantParamsSchema,
  updateTenantBodySchema,
  updateTenantParamsSchema,
} from './admin.types.js';
import {
  createImpersonationToken,
  createTenant,
  getTenantStats,
  listTenants,
  updateTenant,
} from './admin.service.js';
import { adminAuditOnSend } from '../../shared/middleware/admin-audit.middleware.js';
import {
  authenticateRequest,
  requireRole,
} from '../../shared/middleware/auth.middleware.js';
import {
  attachPublicDb,
  releaseTenantDb,
} from '../../shared/middleware/tenant.middleware.js';

const handleError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: 'Validation error',
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
  }

  const maybePgError = error as { code?: string; message?: string };
  if (maybePgError?.code === '23505') {
    return reply.code(409).send({
      error: 'Resource already exists',
      code: 'CONFLICT',
      statusCode: 409,
    });
  }

  const message = error instanceof Error ? error.message : 'Unexpected error';

  if (message === 'Tenant not found') {
    return reply.code(404).send({
      error: message,
      code: 'NOT_FOUND',
      statusCode: 404,
    });
  }

  if (
    message === 'Invalid access token' ||
    message === 'Unauthorized' ||
    message === 'Missing Authorization header' ||
    message === 'Invalid Authorization header'
  ) {
    return reply.code(401).send({
      error: message,
      code: 'UNAUTHORIZED',
      statusCode: 401,
    });
  }

  if (message.includes('Role')) {
    return reply.code(403).send({
      error: message,
      code: 'FORBIDDEN',
      statusCode: 403,
    });
  }

  return reply.code(400).send({
    error: message,
    code: 'BAD_REQUEST',
    statusCode: 400,
  });
};

export default async function adminController(app: FastifyInstance): Promise<void> {
  app.addHook('onSend', adminAuditOnSend);
  app.addHook('onResponse', async (request) => {
    await releaseTenantDb(request);
  });

  const preHandlers = [authenticateRequest, requireRole('super_admin'), attachPublicDb];

  const ensurePublicDb = (request: FastifyRequest) => {
    if (!request.db) {
      throw new Error('Public database not initialized');
    }

    return request.db;
  };

  app.get('/api/v1/admin/tenants', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const query = listTenantsQuerySchema.parse(request.query);
      const result = await listTenants(ensurePublicDb(request), query);
      return reply.send(result);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post('/api/v1/admin/tenants', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const payload = createTenantBodySchema.parse(request.body);
      const result = await createTenant(ensurePublicDb(request), payload);
      return reply.code(201).send(result);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.patch(
    '/api/v1/admin/tenants/:id',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const { id } = updateTenantParamsSchema.parse(request.params);
        const payload = updateTenantBodySchema.parse(request.body);

        await updateTenant(ensurePublicDb(request), id, payload);

        return reply.send({
          success: true,
        });
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.get(
    '/api/v1/admin/tenants/:id/stats',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const { id } = tenantParamsSchema.parse(request.params);
        const result = await getTenantStats(ensurePublicDb(request), id);
        return reply.send(result);
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.post(
    '/api/v1/admin/tenants/:id/impersonate',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const { id } = tenantParamsSchema.parse(request.params);
        const result = await createImpersonationToken(
          ensurePublicDb(request),
          id,
          request.auth?.sub
        );
        return reply.send(result);
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );
}
