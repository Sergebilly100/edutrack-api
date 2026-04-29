import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { withTenantSchema } from '../../shared/database/db.js';
import { requirePermission } from '../../shared/middleware/auth.middleware.js';
import { SubscriptionsRepository } from './subscriptions.repository.js';
import { SubscriptionsModuleError, SubscriptionsService } from './subscriptions.service.js';
import {
  cancelSubscriptionBodySchema,
  cancelSubscriptionParamsSchema,
  commissionRecordPaymentBodySchema,
  createParentSubscriptionBodySchema,
  listParentsQuerySchema,
  parentIdParamsSchema,
  resetPasswordParamsSchema,
  revenueHistoryQuerySchema,
  revenueSummaryQuerySchema,
  renewParentSubscriptionBodySchema,
} from './subscriptions.types.js';

const handleError = (request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply => {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: 'Validation error',
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
  }
  if (error instanceof SubscriptionsModuleError) {
    return reply.code(error.statusCode).send({
      error: error.message,
      code: error.code,
      statusCode: error.statusCode,
    });
  }
  request.log.error(
    { err: error instanceof Error ? error.message : 'unknown error' },
    '[subscriptions] unhandled error'
  );
  return reply.code(500).send({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
    statusCode: 500,
  });
};

export default async function subscriptionsController(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/subscriptions/parents',
    { preHandler: requirePermission('subscriptions.view') },
    async (request, reply) => {
      try {
        const query = listParentsQuerySchema.parse(request.query ?? {});
        const claims = request.claims!;
        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          const service = new SubscriptionsService(new SubscriptionsRepository(tenantDb));
          return service.listParents(claims.schemaName, query);
        });
        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.post(
    '/api/v1/subscriptions/parents',
    { preHandler: requirePermission('subscriptions.create') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const body = createParentSubscriptionBodySchema.parse(request.body ?? {});
        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          const service = new SubscriptionsService(new SubscriptionsRepository(tenantDb));
          return service.createParentSubscription({
            schemaName: claims.schemaName,
            actorUserId: claims.sub,
            payload: body,
          });
        });
        return reply.code(201).send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get(
    '/api/v1/subscriptions/parents/:parentId',
    { preHandler: requirePermission('subscriptions.view') },
    async (request, reply) => {
      try {
        const { parentId } = parentIdParamsSchema.parse(request.params ?? {});
        const claims = request.claims!;
        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          const service = new SubscriptionsService(new SubscriptionsRepository(tenantDb));
          return service.getParentDetails(parentId);
        });
        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.post(
    '/api/v1/subscriptions/parents/:parentId/renew',
    { preHandler: requirePermission('subscriptions.renew') },
    async (request, reply) => {
      try {
        const { parentId } = parentIdParamsSchema.parse(request.params ?? {});
        const body = renewParentSubscriptionBodySchema.parse(request.body ?? {});
        const claims = request.claims!;
        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          const service = new SubscriptionsService(new SubscriptionsRepository(tenantDb));
          return service.renewParentSubscription({
            parentId,
            actorUserId: claims.sub,
            payload: body,
            schemaName: claims.schemaName,
          });
        });
        return reply.code(201).send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.patch(
    '/api/v1/subscriptions/parents/:parentId/subscription/:subscriptionId/cancel',
    { preHandler: requirePermission('subscriptions.cancel') },
    async (request, reply) => {
      try {
        const { subscriptionId } = cancelSubscriptionParamsSchema.parse(request.params ?? {});
        cancelSubscriptionBodySchema.parse(request.body ?? {});
        const claims = request.claims!;
        await withTenantSchema(claims.schemaName, async (tenantDb) => {
          const service = new SubscriptionsService(new SubscriptionsRepository(tenantDb));
          await service.cancelSubscription(subscriptionId);
        });
        return reply.send({ success: true });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.post(
    '/api/v1/subscriptions/parents/:parentId/reset-password',
    { preHandler: requirePermission('subscriptions.create') },
    async (request, reply) => {
      try {
        const { parentId } = resetPasswordParamsSchema.parse(request.params ?? {});
        const claims = request.claims!;
        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          const service = new SubscriptionsService(new SubscriptionsRepository(tenantDb));
          return service.resetParentPassword(parentId);
        });
        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get(
    '/api/v1/subscriptions/revenue/summary',
    { preHandler: requirePermission('subscriptions.revenue') },
    async (request, reply) => {
      try {
        const query = revenueSummaryQuerySchema.parse(request.query ?? {});
        const claims = request.claims!;
        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          const service = new SubscriptionsService(new SubscriptionsRepository(tenantDb));
          return service.revenueSummary(claims.schemaName, query.month);
        });
        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get(
    '/api/v1/subscriptions/revenue/history',
    { preHandler: requirePermission('subscriptions.revenue') },
    async (request, reply) => {
      try {
        const query = revenueHistoryQuerySchema.parse(request.query ?? {});
        const claims = request.claims!;
        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          const service = new SubscriptionsService(new SubscriptionsRepository(tenantDb));
          return service.revenueHistory(claims.schemaName, query.months);
        });
        return reply.send({ months: result });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.post(
    '/api/v1/subscriptions/revenue/commission/record-payment',
    { preHandler: requirePermission('subscriptions.revenue') },
    async (request, reply) => {
      try {
        const body = commissionRecordPaymentBodySchema.parse(request.body ?? {});
        const claims = request.claims!;
        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          const service = new SubscriptionsService(new SubscriptionsRepository(tenantDb));
          return service.recordCommissionPayment({
            schemaName: claims.schemaName,
            periodMonth: body.period_month,
            amountFcfa: body.amount_fcfa,
            notes: body.notes,
            idempotencyKey: body.idempotency_key,
            actorId: claims.sub,
            actorRole: claims.role,
          });
        });
        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );
}
