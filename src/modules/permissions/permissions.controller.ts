import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { withTenantSchema } from '../../shared/database/db.js';
import {
  authenticateRequest,
  requirePermission,
} from '../../shared/middleware/auth.middleware.js';

import { PermissionsModuleError, buildPermissionsService } from './permissions.service.js';
import {
  administrativeUserIdParamsSchema,
  assignPositionBodySchema,
  assignPositionParamsSchema,
  createAdministrativeUserBodySchema,
  createPositionBodySchema,
  positionIdParamsSchema,
  resetAdministrativeUserPasswordBodySchema,
  removeAssignmentParamsSchema,
  updateAdministrativeUserBodySchema,
  updateLimitsBodySchema,
  updatePositionBodySchema,
  updateSchoolConfigBodySchema,
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

const assertSettingsManager = (role: string): void => {
  if (role !== 'director' && role !== 'super_admin') {
    throw new PermissionsModuleError('Forbidden', 403, 'FORBIDDEN');
  }
};

export default async function permissionsController(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/permissions/config',
    { preHandler: requirePermission('settings.positions') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        assertSettingsManager(claims.role);

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          return buildPermissionsService(tenantDb).getConfig(claims.schemaName);
        });

        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.patch(
    '/api/v1/permissions/config/school',
    { preHandler: requirePermission('settings.school') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        assertSettingsManager(claims.role);
        const body = updateSchoolConfigBodySchema.parse(request.body ?? {});

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          return buildPermissionsService(tenantDb).updateSchoolConfig(claims.schemaName, {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.city !== undefined ? { city: body.city } : {}),
            ...(body.teachingType !== undefined ? { teachingType: body.teachingType } : {}),
            ...(body.logoUrl !== undefined ? { logoUrl: body.logoUrl } : {}),
            ...(body.activeSchoolYear !== undefined
              ? { activeSchoolYear: body.activeSchoolYear }
              : {}),
          });
        });

        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.patch(
    '/api/v1/permissions/config/limits',
    { preHandler: requirePermission('settings.school') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        assertSettingsManager(claims.role);
        if (claims.role !== 'super_admin') {
          throw new PermissionsModuleError(
            'Only super admin can update limits',
            403,
            'FORBIDDEN'
          );
        }
        const body = updateLimitsBodySchema.parse(request.body ?? {});

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          return buildPermissionsService(tenantDb).updateLimits(claims.schemaName, {
            maxAdminPositions: body.max_admin_positions,
          });
        });

        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.post(
    '/api/v1/permissions/users',
    { preHandler: requirePermission('settings.positions') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        assertSettingsManager(claims.role);
        const body = createAdministrativeUserBodySchema.parse(request.body ?? {});

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          return buildPermissionsService(tenantDb).createAdministrativeUser(
            {
              name: body.name,
              email: body.email,
              phone: body.phone,
              password: body.password,
            },
            { schemaName: claims.schemaName }
          );
        });

        return reply.code(201).send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.put(
    '/api/v1/permissions/users/:id',
    { preHandler: requirePermission('settings.positions') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        assertSettingsManager(claims.role);
        const params = administrativeUserIdParamsSchema.parse(request.params ?? {});
        const body = updateAdministrativeUserBodySchema.parse(request.body ?? {});

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          return buildPermissionsService(tenantDb).updateAdministrativeUser(params.id, {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.email !== undefined ? { email: body.email } : {}),
            ...(body.phone !== undefined ? { phone: body.phone } : {}),
          });
        });

        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.delete(
    '/api/v1/permissions/users/:id',
    { preHandler: requirePermission('settings.positions') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        assertSettingsManager(claims.role);
        const params = administrativeUserIdParamsSchema.parse(request.params ?? {});

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          return buildPermissionsService(tenantDb).deleteAdministrativeUser(params.id);
        });

        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.post(
    '/api/v1/permissions/users/:id/reset-password',
    { preHandler: requirePermission('settings.positions') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        assertSettingsManager(claims.role);
        const params = administrativeUserIdParamsSchema.parse(request.params ?? {});
        const body = resetAdministrativeUserPasswordBodySchema.parse(request.body ?? {});

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          return buildPermissionsService(tenantDb).resetAdministrativeUserPassword(params.id, {
            newPassword: body.newPassword,
          });
        });

        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get(
    '/api/v1/permissions/positions',
    { preHandler: requirePermission('settings.positions') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        assertSettingsManager(claims.role);

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          return buildPermissionsService(tenantDb).listPositions(claims.schemaName);
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
        assertSettingsManager(claims.role);
        const body = createPositionBodySchema.parse(request.body ?? {});

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          return buildPermissionsService(tenantDb).createPosition({
            name: body.name,
            permissions: body.permissions,
            createdBy: claims.sub,
            schemaName: claims.schemaName,
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
        assertSettingsManager(claims.role);
        const params = positionIdParamsSchema.parse(request.params ?? {});
        const body = updatePositionBodySchema.parse(request.body ?? {});

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          return buildPermissionsService(tenantDb).updatePosition(params.id, {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.permissions !== undefined ? { permissions: body.permissions } : {}),
            schemaName: claims.schemaName,
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
        assertSettingsManager(claims.role);
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
        assertSettingsManager(claims.role);
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
        assertSettingsManager(claims.role);
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
