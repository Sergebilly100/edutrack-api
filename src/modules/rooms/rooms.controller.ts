import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { withTenantSchema } from '../../shared/database/db.js';
import { requirePermission } from '../../shared/middleware/auth.middleware.js';

import { buildRoomsService, RoomsModuleError } from './rooms.service.js';
import {
  createRoomBodySchema,
  roomIdParamsSchema,
  updateRoomBodySchema,
} from './rooms.types.js';

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

  if (error instanceof RoomsModuleError) {
    return reply.code(error.statusCode).send({
      error: error.message,
      code: error.code,
      statusCode: error.statusCode,
    });
  }

  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: string }).code;
    if (code === '23505') {
      return reply.code(409).send({
        error: 'Conflict with existing data',
        code: 'CONFLICT',
        statusCode: 409,
      });
    }
  }

  request.log.error(
    { err: error instanceof Error ? error.message : 'unknown error' },
    '[rooms] unhandled error'
  );
  return reply.code(500).send({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
    statusCode: 500,
  });
};

export default async function roomsController(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/rooms', { preHandler: requirePermission('rooms.view') }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        return buildRoomsService(tenantDb).listActiveRooms();
      });

      return reply.send(result);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.post('/api/v1/rooms', { preHandler: requirePermission('rooms.create') }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const body = createRoomBodySchema.parse(request.body ?? {});

      const room = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        return buildRoomsService(tenantDb).createRoom(body);
      });

      return reply.code(201).send({ room });
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.put('/api/v1/rooms/:id', { preHandler: requirePermission('rooms.edit') }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const params = roomIdParamsSchema.parse(request.params ?? {});
      const body = updateRoomBodySchema.parse(request.body ?? {});

      const room = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        return buildRoomsService(tenantDb).updateRoom(params.id, body);
      });

      return reply.send({ room });
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.patch('/api/v1/rooms/:id', { preHandler: requirePermission('rooms.edit') }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const params = roomIdParamsSchema.parse(request.params ?? {});
      const body = updateRoomBodySchema.parse(request.body ?? {});

      const room = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        return buildRoomsService(tenantDb).updateRoom(params.id, body);
      });

      return reply.send({ room });
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.delete('/api/v1/rooms/:id', { preHandler: requirePermission('rooms.delete') }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const params = roomIdParamsSchema.parse(request.params ?? {});

      const room = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        return buildRoomsService(tenantDb).deleteRoom(params.id);
      });

      return reply.send({ room });
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.post(
    '/api/v1/rooms/:id/regenerate-token',
    { preHandler: requirePermission('rooms.edit') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const params = roomIdParamsSchema.parse(request.params ?? {});

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          return buildRoomsService(tenantDb).regenerateToken(params.id);
        });

        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get('/api/v1/rooms/:id/qr', { preHandler: requirePermission('rooms.view') }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const params = roomIdParamsSchema.parse(request.params ?? {});

      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        return buildRoomsService(tenantDb).getRoomQr(params.id);
      });

      return reply.send(result);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });
}
