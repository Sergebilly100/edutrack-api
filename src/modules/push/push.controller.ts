import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';

import { withTenantSchema } from '../../shared/database/db.js';
import { authenticateRequest, requireParent } from '../../shared/middleware/auth.middleware.js';

import { PushRepository, type SubscriberType } from './push.repository.js';

const subscribeBodySchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

const unsubscribeBodySchema = z.object({
  endpoint: z.string().url(),
});

const handleError = (request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply => {
  if (error instanceof ZodError) {
    return reply.code(400).send({ error: 'Validation error', code: 'BAD_REQUEST', statusCode: 400 });
  }
  request.log.error(
    { err: error instanceof Error ? error.message : 'unknown' },
    '[push] unhandled error'
  );
  return reply.code(500).send({ error: 'Internal error', code: 'INTERNAL', statusCode: 500 });
};

const registerSubscription = async (
  request: FastifyRequest,
  reply: FastifyReply,
  subscriberType: SubscriberType,
  subscriberId: string,
  schemaName: string
): Promise<FastifyReply> => {
  const body = subscribeBodySchema.parse(request.body ?? {});
  const userAgent = request.headers['user-agent'] ?? null;
  await withTenantSchema(schemaName, async (tenantDb) => {
    await new PushRepository(tenantDb).upsert({
      subscriberType,
      subscriberId,
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      userAgent,
    });
  });
  return reply.code(201).send({ success: true });
};

const removeSubscription = async (
  request: FastifyRequest,
  reply: FastifyReply,
  schemaName: string
): Promise<FastifyReply> => {
  const body = unsubscribeBodySchema.parse(request.body ?? {});
  await withTenantSchema(schemaName, async (tenantDb) => {
    await new PushRepository(tenantDb).deleteByEndpoint(body.endpoint);
  });
  return reply.send({ success: true });
};

export default async function pushController(app: FastifyInstance): Promise<void> {
  // ── Staff / prof / directeur ────────────────────────────────────────────────
  app.post('/api/v1/push/subscribe', { preHandler: authenticateRequest }, async (request, reply) => {
    try {
      const claims = request.claims;
      if (!claims) {
        return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED', statusCode: 401 });
      }
      return await registerSubscription(request, reply, 'user', claims.sub, claims.schemaName);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.post('/api/v1/push/unsubscribe', { preHandler: authenticateRequest }, async (request, reply) => {
    try {
      const claims = request.claims;
      if (!claims) {
        return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED', statusCode: 401 });
      }
      return await removeSubscription(request, reply, claims.schemaName);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  // ── Parent ──────────────────────────────────────────────────────────────────
  app.post('/api/v1/parent/push/subscribe', { preHandler: requireParent }, async (request, reply) => {
    try {
      const claims = request.claims;
      if (!claims || !request.parentId) {
        return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED', statusCode: 401 });
      }
      return await registerSubscription(request, reply, 'parent', request.parentId, claims.schemaName);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.post('/api/v1/parent/push/unsubscribe', { preHandler: requireParent }, async (request, reply) => {
    try {
      const claims = request.claims;
      if (!claims) {
        return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED', statusCode: 401 });
      }
      return await removeSubscription(request, reply, claims.schemaName);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });
}
