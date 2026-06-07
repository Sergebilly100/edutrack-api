import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';

import { withTenantSchema } from '../../shared/database/db.js';
import {
  requireDirectorOrSecretary,
  requirePermission,
} from '../../shared/middleware/auth.middleware.js';
import type { PdfExportQueueHandle } from '../billing/billing.queue.js';
import { SubscriptionsRepository } from './subscriptions.repository.js';
import { SubscriptionsModuleError, SubscriptionsService } from './subscriptions.service.js';
import {
  cancelSubscriptionBodySchema,
  cancelSubscriptionParamsSchema,
  createParentSubscriptionBodySchema,
  listParentsQuerySchema,
  parentIdParamsSchema,
  resetPasswordParamsSchema,
  revenuePaymentsQuerySchema,
  revenueHistoryQuerySchema,
  revenueSummaryQuerySchema,
  renewParentSubscriptionBodySchema,
  updateParentContactBodySchema,
  subscriptionClassesQuerySchema,
  subscriptionClassStudentsQuerySchema,
  updateSmsPriceBodySchema,
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

const revenueExportBodySchema = z
  .object({
    periodFrom: z.string().regex(/^\d{4}-\d{2}$/),
    periodTo: z.string().regex(/^\d{4}-\d{2}$/),
  })
  .refine((value) => value.periodFrom <= value.periodTo, {
    message: 'periodFrom must be before or equal to periodTo',
    path: ['periodFrom'],
  });

export default async function subscriptionsController(
  app: FastifyInstance,
  options: { pdfQueue?: PdfExportQueueHandle } = {}
): Promise<void> {
  app.get(
    '/api/v1/settings/sms-price',
    { preHandler: requireDirectorOrSecretary },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          const service = new SubscriptionsService(new SubscriptionsRepository(tenantDb));
          return service.getSchoolSmsFeatureSettings(claims.schemaName);
        });
        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.patch(
    '/api/v1/settings/sms-price',
    { preHandler: requirePermission('settings.school') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const body = updateSmsPriceBodySchema.parse(request.body ?? {});
        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          const service = new SubscriptionsService(new SubscriptionsRepository(tenantDb));
          return service.updateSchoolSmsUnitPrice({
            schemaName: claims.schemaName,
            smsUnitPriceFcfa: body.sms_unit_price_fcfa,
          });
        });
        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get(
    '/api/v1/subscriptions/classes',
    { preHandler: requirePermission('subscriptions.view') },
    async (request, reply) => {
      try {
        const query = subscriptionClassesQuerySchema.parse(request.query ?? {});
        const claims = request.claims!;
        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          const service = new SubscriptionsService(new SubscriptionsRepository(tenantDb));
          return service.listSubscriptionClasses({ search: query.search });
        });
        return reply.send({ data: result });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get(
    '/api/v1/subscriptions/creators',
    { preHandler: requirePermission('subscriptions.view') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          const service = new SubscriptionsService(new SubscriptionsRepository(tenantDb));
          return service.listCreators();
        });
        return reply.send({ data: result });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get(
    '/api/v1/subscriptions/students',
    { preHandler: requirePermission('subscriptions.view') },
    async (request, reply) => {
      try {
        const query = subscriptionClassStudentsQuerySchema.parse(request.query ?? {});
        const claims = request.claims!;
        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          const service = new SubscriptionsService(new SubscriptionsRepository(tenantDb));
          return service.listSubscriptionStudentsByClass({
            classId: query.class_id,
            page: query.page,
            limit: query.limit,
            search: query.search,
          });
        });
        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

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
    '/api/v1/subscriptions/parents/:parentId/contact',
    { preHandler: requirePermission('subscriptions.edit') },
    async (request, reply) => {
      try {
        const { parentId } = parentIdParamsSchema.parse(request.params ?? {});
        const body = updateParentContactBodySchema.parse(request.body ?? {});
        const claims = request.claims!;
        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          const service = new SubscriptionsService(new SubscriptionsRepository(tenantDb));
          return service.updateParentContact({
            parentId,
            actorUserId: claims.sub,
            actorRole: claims.role,
            schemaName: claims.schemaName,
            payload: body,
          });
        });
        return reply.send(result);
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
        const { parentId, subscriptionId } = cancelSubscriptionParamsSchema.parse(request.params ?? {});
        cancelSubscriptionBodySchema.parse(request.body ?? {});
        const claims = request.claims!;
        await withTenantSchema(claims.schemaName, async (tenantDb) => {
          const service = new SubscriptionsService(new SubscriptionsRepository(tenantDb));
          await service.cancelSubscription(subscriptionId, parentId, claims.sub);
        });
        return reply.send({ success: true });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.post(
    '/api/v1/subscriptions/parents/:parentId/reset-password',
    { preHandler: requirePermission('subscriptions.password.reset') },
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

  app.get(
    '/api/v1/subscriptions/revenue/payments',
    { preHandler: requirePermission('subscriptions.revenue') },
    async (request, reply) => {
      try {
        const query = revenuePaymentsQuerySchema.parse(request.query ?? {});
        const claims = request.claims!;
        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          const service = new SubscriptionsService(new SubscriptionsRepository(tenantDb));
          return service.revenuePayments(claims.schemaName, query.month);
        });
        return reply.send({ data: result });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get(
    '/api/v1/subscriptions/revenue/subscriptions',
    { preHandler: requirePermission('subscriptions.revenue') },
    async (request, reply) => {
      try {
        const query = revenuePaymentsQuerySchema.parse(request.query ?? {});
        const claims = request.claims!;
        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          const service = new SubscriptionsService(new SubscriptionsRepository(tenantDb));
          return service.revenueSubscriptionDetails(claims.schemaName, query.month);
        });
        return reply.send({ data: result });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get(
    '/api/v1/subscriptions/revenue/commission/overdue-alerts',
    { preHandler: requirePermission('subscriptions.revenue') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          const service = new SubscriptionsService(new SubscriptionsRepository(tenantDb));
          return service.commissionOverdueAlerts(claims.schemaName);
        });
        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  // Bilan des reversements (PDF asynchrone via la queue d'export).
  // Remplace l'ancienne impression HTML navigateur.
  app.post(
    '/api/v1/subscriptions/revenue/export',
    { preHandler: requirePermission('subscriptions.revenue') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const body = revenueExportBodySchema.parse(request.body ?? {});

        if (!options.pdfQueue) {
          return reply.code(503).send({
            error: 'Export queue unavailable',
            code: 'EXPORT_QUEUE_UNAVAILABLE',
            statusCode: 503,
          });
        }

        const job = await options.pdfQueue.add(
          'revenue-export',
          {
            type: 'revenue-export',
            schemaName: claims.schemaName,
            periodFrom: body.periodFrom,
            periodTo: body.periodTo,
          },
          { removeOnComplete: 100, removeOnFail: 100 }
        );

        return reply.send({ jobId: job.id });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

}
