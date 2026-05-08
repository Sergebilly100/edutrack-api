import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { ZodError } from 'zod';

import { withTenantSchema } from '../../shared/database/db.js';
import { requirePermission } from '../../shared/middleware/auth.middleware.js';

import {
  BILLING_EXPORT_DIR,
  type BillingPdfJobData,
} from './billing.queue.js';
import { BillingModuleError, buildBillingService } from './billing.service.js';
import {
  jobParamsSchema,
  jobDownloadQuerySchema,
  monthQuerySchema,
  recordParamsSchema,
  salaryHistoryQuerySchema,
  salaryBulkExportBodySchema,
  salarySingleExportBodySchema,
  teacherParamsSchema,
  updateSalaryStatusBodySchema,
} from './billing.types.js';

// const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const EXPORT_SIGNING_WINDOW_MS = 15 * 60 * 1000;
const exportDirRoot = path.resolve(BILLING_EXPORT_DIR);

const buildSigningSecret = (): string => {
  const configured = process.env.SALARY_EXPORT_SIGNING_SECRET?.trim();
  if (configured) {
    return configured;
  }

  const jwtKey = process.env.JWT_PRIVATE_KEY?.trim();
  if (jwtKey) {
    return jwtKey;
  }

  return 'edutrack-salary-export-dev-secret';
};

const SIGNING_SECRET = buildSigningSecret();

// export const billingPdfQueue = new Queue<BillingPdfJobData, BillingPdfJobResult>(
//   BILLING_PDF_QUEUE_NAME,
//   {
//     connection: {
//       url: redisUrl,
//     },
//   }
// );

const resolveBaseUrl = (request: FastifyRequest): string => {
  const configured = process.env.APP_BASE_URL?.trim();
  if (configured) {
    return configured.replace(/\/$/, '');
  }

  const host = request.headers.host;
  if (!host) {
    return 'http://localhost:3000';
  }

  return `${request.protocol}://${host}`;
};

const signDownload = (jobId: string, expires: number): string => {
  return createHmac('sha256', SIGNING_SECRET).update(`${jobId}.${expires}`).digest('hex');
};

const verifyDownloadSignature = (jobId: string, expires: number, signature: string): boolean => {
  const expected = signDownload(jobId, expires);
  const expectedBuffer = Buffer.from(expected, 'hex');
  const signatureBuffer = Buffer.from(signature, 'hex');
  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, signatureBuffer);
};

const buildSignedDownloadUrl = (request: FastifyRequest, jobId: string): string => {
  const expires = Date.now() + EXPORT_SIGNING_WINDOW_MS;
  const signature = signDownload(jobId, expires);
  const query = new URLSearchParams({
    expires: String(expires),
    signature,
  });
  return `${resolveBaseUrl(request)}/api/v1/jobs/${encodeURIComponent(jobId)}/download?${query.toString()}`;
};

const mapJobStatus = (state: string): 'pending' | 'processing' | 'done' | 'failed' => {
  if (state === 'completed') {
    return 'done';
  }

  if (state === 'active') {
    return 'processing';
  }

  if (state === 'failed') {
    return 'failed';
  }

  return 'pending';
};

const resolveJobFileResult = (result: unknown): { filePath: string; fileName: string } | null => {
  if (!result || typeof result !== 'object') {
    return null;
  }

  const resultRecord = result as Record<string, unknown>;
  const filePath = resultRecord.filePath;
  const fileName = resultRecord.fileName;
  if (typeof filePath !== 'string' || typeof fileName !== 'string') {
    return null;
  }

  return { filePath, fileName };
};

type BillingPdfJobHandle = {
  id?: string | number;
  returnvalue?: unknown;
  failedReason?: string | null;
  getState: () => Promise<string>;
};

type BillingPdfQueueHandle = {
  add: (
    name: string,
    data: BillingPdfJobData,
    options?: { removeOnComplete?: number; removeOnFail?: number }
  ) => Promise<BillingPdfJobHandle>;
  getJob: (jobId: string) => Promise<BillingPdfJobHandle | null>;
};

const createInMemoryBillingPdfQueue = (): BillingPdfQueueHandle => {
  let sequence = 0;
  const jobs = new Map<string, BillingPdfJobHandle>();

  return {
    add: async () => {
      sequence += 1;
      const id = `memory-${sequence}`;
      const job: BillingPdfJobHandle = {
        id,
        getState: async () => 'waiting',
      };
      jobs.set(id, job);
      return job;
    },
    getJob: async (jobId: string) => jobs.get(jobId) ?? null,
  };
};

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

export default async function billingController(
  app: FastifyInstance,
  // La queue est injectée depuis server.ts — testable, pas de doublon Redis
  options: { billingPdfQueue?: BillingPdfQueueHandle } = {}
): Promise<void> {
  // Toutes les références à billingPdfQueue dans le corps utilisent options.billingPdfQueue
  const billingPdfQueue = options.billingPdfQueue ?? createInMemoryBillingPdfQueue();

  app.get(
    '/api/v1/billing/salary/summary',
    { preHandler: requirePermission('salary.view') },
    async (request, reply) => {
      try {
        const claims = request.claims
if (!claims) {
  // Ne devrait jamais arriver si requirePermission est actif,
  // mais on garde un guard défensif pour le strict mode
  return reply.code(401).send({
    error: 'Unauthorized',
    code: 'MISSING_CLAIMS',
    statusCode: 401,
  })
}
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
    '/api/v1/billing/salary/unpaid-alerts',
    { preHandler: requirePermission('salary.view') },
    async (request, reply) => {
      try {
        const claims = request.claims
if (!claims) {
  // Ne devrait jamais arriver si requirePermission est actif,
  // mais on garde un guard défensif pour le strict mode
  return reply.code(401).send({
    error: 'Unauthorized',
    code: 'MISSING_CLAIMS',
    statusCode: 401,
  })
}
        const query = monthQuerySchema.parse(request.query ?? {});

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          return buildBillingService(tenantDb).getPastUnpaidSalaryAlerts(query.month);
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
        const claims = request.claims
if (!claims) {
  // Ne devrait jamais arriver si requirePermission est actif,
  // mais on garde un guard défensif pour le strict mode
  return reply.code(401).send({
    error: 'Unauthorized',
    code: 'MISSING_CLAIMS',
    statusCode: 401,
  })
}
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

  app.get(
    '/api/v1/billing/salary/:teacherId/payments',
    { preHandler: requirePermission('salary.view') },
    async (request, reply) => {
      try {
        const claims = request.claims
if (!claims) {
  // Ne devrait jamais arriver si requirePermission est actif,
  // mais on garde un guard défensif pour le strict mode
  return reply.code(401).send({
    error: 'Unauthorized',
    code: 'MISSING_CLAIMS',
    statusCode: 401,
  })
}
        const params = teacherParamsSchema.parse(request.params ?? {});
        const query = salaryHistoryQuerySchema.parse(request.query ?? {});

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          return buildBillingService(tenantDb).getTeacherPaymentHistory(params.teacherId, query.limit);
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
        const claims = request.claims
if (!claims) {
  // Ne devrait jamais arriver si requirePermission est actif,
  // mais on garde un guard défensif pour le strict mode
  return reply.code(401).send({
    error: 'Unauthorized',
    code: 'MISSING_CLAIMS',
    statusCode: 401,
  })
}
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
        const claims = request.claims
if (!claims) {
  // Ne devrait jamais arriver si requirePermission est actif,
  // mais on garde un guard défensif pour le strict mode
  return reply.code(401).send({
    error: 'Unauthorized',
    code: 'MISSING_CLAIMS',
    statusCode: 401,
  })
}
        const params = recordParamsSchema.parse(request.params ?? {});
        const body = updateSalaryStatusBodySchema.parse(request.body ?? {});

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          return buildBillingService(tenantDb).updateSalaryRecordStatus({
            recordId: params.recordId,
            status: body.status,
            notes: body.notes,
            hoursToPay: body.hoursToPay,
            actor: {
              userId: claims.sub,
              role: claims.role as 'director' | 'staff' | 'teacher' | 'super_admin',
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
        const claims = request.claims
if (!claims) {
  // Ne devrait jamais arriver si requirePermission est actif,
  // mais on garde un guard défensif pour le strict mode
  return reply.code(401).send({
    error: 'Unauthorized',
    code: 'MISSING_CLAIMS',
    statusCode: 401,
  })
}
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

  app.post(
    '/api/v1/billing/salary/export',
    { preHandler: requirePermission('salary.export') },
    async (request, reply) => {
      try {
        const claims = request.claims
if (!claims) {
  // Ne devrait jamais arriver si requirePermission est actif,
  // mais on garde un guard défensif pour le strict mode
  return reply.code(401).send({
    error: 'Unauthorized',
    code: 'MISSING_CLAIMS',
    statusCode: 401,
  })
}
        const body = salarySingleExportBodySchema.parse(request.body ?? {});

        const job = await billingPdfQueue.add(
          'salary-export-single',
          {
            type: 'salary-export-teacher',
            schemaName: claims.schemaName,
            month: body.periodMonth,
            teacherId: body.teacherId,
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
        const claims = request.claims
if (!claims) {
  // Ne devrait jamais arriver si requirePermission est actif,
  // mais on garde un guard défensif pour le strict mode
  return reply.code(401).send({
    error: 'Unauthorized',
    code: 'MISSING_CLAIMS',
    statusCode: 401,
  })
}
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

  app.post(
    '/api/v1/billing/salary/export/bulk',
    { preHandler: requirePermission('salary.export') },
    async (request, reply) => {
      try {
        const claims = request.claims
if (!claims) {
  // Ne devrait jamais arriver si requirePermission est actif,
  // mais on garde un guard défensif pour le strict mode
  return reply.code(401).send({
    error: 'Unauthorized',
    code: 'MISSING_CLAIMS',
    statusCode: 401,
  })
}
        const body = salaryBulkExportBodySchema.parse(request.body ?? {});

        const job = await billingPdfQueue.add(
          'salary-export-bulk',
          {
            type: 'salary-export-bulk',
            schemaName: claims.schemaName,
            periodFrom: body.periodFrom,
            periodTo: body.periodTo,
            teacherId: body.teacherId ?? null,
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
        status: 'pending' | 'processing' | 'done' | 'failed';
        resultUrl?: string;
        result?: unknown;
        failedReason?: string;
      } = {
        jobId: String(job.id),
        state,
        status: mapJobStatus(state),
      };

      if (state === 'completed') {
        const resultUrl = buildSignedDownloadUrl(request, String(job.id));
        const jobResult = resolveJobFileResult(job.returnvalue);
        response.resultUrl = resultUrl;
        response.result = {
          ...(job.returnvalue && typeof job.returnvalue === 'object' ? job.returnvalue : {}),
          ...(jobResult ? { downloadUrl: resultUrl, resultUrl } : {}),
        };
      }

      if (state === 'failed') {
        response.failedReason = job.failedReason ?? 'Unknown failure';
      }

      return reply.send(response);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.get('/api/v1/jobs/:jobId/status', { preHandler: requirePermission('salary.export') }, async (request, reply) => {
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
      const status = mapJobStatus(state);
      const response: {
        jobId: string;
        status: 'pending' | 'processing' | 'done' | 'failed';
        resultUrl?: string;
        failedReason?: string;
      } = {
        jobId: String(job.id),
        status,
      };

      if (status === 'done' && resolveJobFileResult(job.returnvalue)) {
        response.resultUrl = buildSignedDownloadUrl(request, String(job.id));
      }

      if (status === 'failed') {
        response.failedReason = job.failedReason ?? 'Unknown failure';
      }

      return reply.send(response);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.get('/api/v1/jobs/:jobId/download', async (request, reply) => {
    try {
      const params = jobParamsSchema.parse(request.params ?? {});
      const query = jobDownloadQuerySchema.parse(request.query ?? {});

      if (Date.now() > query.expires) {
        return reply.code(401).send({
          error: 'Download URL expired',
          code: 'DOWNLOAD_URL_EXPIRED',
          statusCode: 401,
        });
      }

      if (!verifyDownloadSignature(params.jobId, query.expires, query.signature)) {
        return reply.code(401).send({
          error: 'Invalid download signature',
          code: 'INVALID_DOWNLOAD_SIGNATURE',
          statusCode: 401,
        });
      }

      const job = await billingPdfQueue.getJob(params.jobId);
      if (!job) {
        return reply.code(404).send({
          error: 'Job not found',
          code: 'JOB_NOT_FOUND',
          statusCode: 404,
        });
      }

      const state = await job.getState();
      if (state !== 'completed') {
        return reply.code(409).send({
          error: 'Export not ready',
          code: 'JOB_NOT_COMPLETED',
          statusCode: 409,
        });
      }

      const result = resolveJobFileResult(job.returnvalue);
      if (!result) {
        return reply.code(500).send({
          error: 'Missing job export file',
          code: 'JOB_RESULT_INVALID',
          statusCode: 500,
        });
      }

      const absoluteFilePath = path.resolve(result.filePath);
      if (!absoluteFilePath.startsWith(`${exportDirRoot}${path.sep}`)) {
        return reply.code(400).send({
          error: 'Invalid file path',
          code: 'INVALID_EXPORT_PATH',
          statusCode: 400,
        });
      }

      await access(absoluteFilePath);

      const extension = path.extname(result.fileName).toLowerCase();
      const contentType = extension === '.zip' ? 'application/zip' : 'application/pdf';

      reply.header('Content-Type', contentType);
      reply.header('Content-Disposition', `attachment; filename="${result.fileName}"`);
      return reply.send(createReadStream(absoluteFilePath));
    } catch (error) {
      return handleError(request, reply, error);
    }
  });
}
