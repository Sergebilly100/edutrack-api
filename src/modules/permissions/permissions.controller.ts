import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { withTenantSchema } from '../../shared/database/db.js';
import {
  authenticateRequest,
  requirePermission,
} from '../../shared/middleware/auth.middleware.js';

import { PermissionsModuleError, buildPermissionsService } from './permissions.service.js';
import {
  assignPositionBodySchema,
  assignPositionParamsSchema,
  createPositionBodySchema,
  positionIdParamsSchema,
  removeAssignmentParamsSchema,
  updatePositionBodySchema,
} from './permissions.types.js';

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

  if (error instanceof PermissionsModuleError) {
    return reply.code(error.statusCode).send({
      error: error.message,
      code: error.code,
      statusCode: error.statusCode,
    });
  }

  request.log.error(
    { err: error instanceof Error ? error.message : 'unknown error' },
    '[permissions] unhandled error'
  );
  return reply.code(500).send({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
    statusCode: 500,
  });
};

export default async function permissionsController(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/permissions/positions',
    { preHandler: requirePermission('settings.positions') },
    async (request, reply) => {
      try {
        const claims = request.claims!;

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          return buildPermissionsService(tenantDb).listPositions();
        });

        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.post(
    '/api/v1/permissions/positions',
    { preHandler: requirePermission('settings.positions') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const body = createPositionBodySchema.parse(request.body ?? {});

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          return buildPermissionsService(tenantDb).createPosition({
            name: body.name,
            permissions: body.permissions,
            createdBy: claims.sub,
          });
        });

        return reply.code(201).send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.put(
    '/api/v1/permissions/positions/:id',
    { preHandler: requirePermission('settings.positions') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const params = positionIdParamsSchema.parse(request.params ?? {});
        const body = updatePositionBodySchema.parse(request.body ?? {});

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          return buildPermissionsService(tenantDb).updatePosition(params.id, {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.permissions !== undefined ? { permissions: body.permissions } : {}),
          });
        });

        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.delete(
    '/api/v1/permissions/positions/:id',
    { preHandler: requirePermission('settings.positions') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const params = positionIdParamsSchema.parse(request.params ?? {});

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          return buildPermissionsService(tenantDb).deletePosition(params.id);
        });

        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.post(
    '/api/v1/permissions/positions/:id/assign',
    { preHandler: requirePermission('settings.positions') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const params = assignPositionParamsSchema.parse(request.params ?? {});
        const body = assignPositionBodySchema.parse(request.body ?? {});

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          return buildPermissionsService(tenantDb).assignPosition({
            positionId: params.id,
            userId: body.userId,
            assignedBy: claims.sub,
          });
        });

        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.delete(
    '/api/v1/permissions/positions/:id/assign/:userId',
    { preHandler: requirePermission('settings.positions') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const params = removeAssignmentParamsSchema.parse(request.params ?? {});

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          return buildPermissionsService(tenantDb).unassignPosition(params.id, params.userId);
        });

        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get('/api/v1/permissions/me', { preHandler: authenticateRequest }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const permissions = request.permissions ?? new Set();
      const result = {
        userId: claims.sub,
        role: claims.role,
        permissions: Array.from(permissions),
      };

      return reply.send(result);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });
}
