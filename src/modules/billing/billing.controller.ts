import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Queue } from 'bullmq';
import { ZodError } from 'zod';

import { withTenantSchema } from '../../shared/database/db.js';
import { requirePermission } from '../../shared/middleware/auth.middleware.js';

import {
  BILLING_PDF_QUEUE_NAME,
  type BillingPdfJobData,
  type BillingPdfJobResult,
} from './billing.queue.js';
import { BillingModuleError, buildBillingService } from './billing.service.js';
import {
  jobParamsSchema,
  monthQuerySchema,
  recordParamsSchema,
  teacherParamsSchema,
  updateSalaryStatusBodySchema,
} from './billing.types.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

export const billingPdfQueue = new Queue<BillingPdfJobData, BillingPdfJobResult>(
  BILLING_PDF_QUEUE_NAME,
  {
    connection: {
      url: redisUrl,
    },
  }
);

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

  if (error instanceof BillingModuleError) {
    return reply.code(error.statusCode).send({
      error: error.message,
      code: error.code,
      statusCode: error.statusCode,
    });
  }

  request.log.error(
    { err: error instanceof Error ? error.message : 'unknown error' },
    '[billing] unhandled error'
  );
  return reply.code(500).send({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
    statusCode: 500,
  });
};

export default async function billingController(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/billing/salary/summary',
    { preHandler: requirePermission('salary.view') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const query = monthQuerySchema.parse(request.query ?? {});

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          return buildBillingService(tenantDb).getSalarySummary(query.month);
        });

        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get(
    '/api/v1/billing/salary/:teacherId',
    { preHandler: requirePermission('salary.view') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const params = teacherParamsSchema.parse(request.params ?? {});
        const query = monthQuerySchema.parse(request.query ?? {});

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          return buildBillingService(tenantDb).getTeacherSalaryDetails(params.teacherId, query.month);
        });

        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.post(
    '/api/v1/billing/salary/compute',
    { preHandler: requirePermission('salary.compute') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const query = monthQuerySchema.parse(request.query ?? {});

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          return buildBillingService(tenantDb).computeSalaryRecords(query.month);
        });

        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.patch(
    '/api/v1/billing/salary/:recordId/status',
    { preHandler: requirePermission('salary.mark_paid') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const params = recordParamsSchema.parse(request.params ?? {});
        const body = updateSalaryStatusBodySchema.parse(request.body ?? {});

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          return buildBillingService(tenantDb).updateSalaryRecordStatus({
            recordId: params.recordId,
            status: body.status,
            notes: body.notes,
            actor: {
              userId: claims.sub,
              role: claims.role,
            },
          });
        });

        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get(
    '/api/v1/billing/salary/export/:teacherId',
    { preHandler: requirePermission('salary.export') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const params = teacherParamsSchema.parse(request.params ?? {});
        const query = monthQuerySchema.parse(request.query ?? {});

        const job = await billingPdfQueue.add(
          'salary-export-teacher',
          {
            type: 'salary-export-teacher',
            schemaName: claims.schemaName,
            month: query.month,
            teacherId: params.teacherId,
          },
          {
            removeOnComplete: 100,
            removeOnFail: 100,
          }
        );

        return reply.send({ jobId: job.id });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get(
    '/api/v1/billing/salary/export/school',
    { preHandler: requirePermission('salary.export') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const query = monthQuerySchema.parse(request.query ?? {});

        const job = await billingPdfQueue.add(
          'salary-export-school',
          {
            type: 'salary-export-school',
            schemaName: claims.schemaName,
            month: query.month,
          },
          {
            removeOnComplete: 100,
            removeOnFail: 100,
          }
        );

        return reply.send({ jobId: job.id });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get('/api/v1/jobs/:jobId', { preHandler: requirePermission('salary.export') }, async (request, reply) => {
    try {
      const params = jobParamsSchema.parse(request.params ?? {});
      const job = await billingPdfQueue.getJob(params.jobId);
      if (!job) {
        return reply.code(404).send({
          error: 'Job not found',
          code: 'JOB_NOT_FOUND',
          statusCode: 404,
        });
      }

      const state = await job.getState();
      const response: {
        jobId: string;
        state: string;
        result?: unknown;
        failedReason?: string;
      } = {
        jobId: String(job.id),
        state,
      };

      if (state === 'completed') {
        response.result = job.returnvalue;
      }

      if (state === 'failed') {
        response.failedReason = job.failedReason ?? 'Unknown failure';
      }

      return reply.send(response);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });
}
