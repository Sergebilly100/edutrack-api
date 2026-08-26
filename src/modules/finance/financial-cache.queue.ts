import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';

import { logger as appLogger } from '../../shared/observability/logger.js';
import { withTenantSchema } from '../../shared/database/db.js';
import { buildFinancialCacheService } from './financial-cache.service.js';

export const FINANCIAL_CACHE_QUEUE_NAME = 'financial-cache';

export type FinancialCacheJobData = {
  schemaName: string;
};

export const processFinancialCacheJob = async (job: Job<FinancialCacheJobData>): Promise<{ studentCount: number }> => {
  appLogger.info({ jobId: job.id, schemaName: job.data.schemaName }, '[financial-cache] recalcul démarré');
  return withTenantSchema(job.data.schemaName, async (tenantDb) => {
    const result = await buildFinancialCacheService(tenantDb).recalcAll();
    appLogger.info({ jobId: job.id, studentCount: result.studentCount }, '[financial-cache] recalcul terminé');
    return result;
  });
};

export const createFinancialCacheQueue = (connection: Redis): Queue<FinancialCacheJobData> =>
  new Queue<FinancialCacheJobData>(FINANCIAL_CACHE_QUEUE_NAME, { connection });

export const createFinancialCacheWorker = (
  connection: Redis
): Worker<FinancialCacheJobData, { studentCount: number }> =>
  new Worker<FinancialCacheJobData, { studentCount: number }>(
    FINANCIAL_CACHE_QUEUE_NAME,
    async (job) => processFinancialCacheJob(job),
    {
      connection,
      concurrency: Number(process.env.FINANCIAL_CACHE_WORKER_CONCURRENCY ?? 2),
    }
  );
