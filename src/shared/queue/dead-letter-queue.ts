import { Queue, type Job, type Worker } from 'bullmq';
import type { Redis } from 'ioredis';

import { captureException } from '../observability/sentry.js';

export const DEAD_LETTER_QUEUE_NAME = 'dead-letter';

export type DeadLetterPayload = {
  originalQueue: string;
  originalJobId?: string;
  originalJobName?: string;
  data: unknown;
  failedReason: string;
  attemptsMade: number;
  failedAt: string;
};

export const createDeadLetterQueue = (connection: Redis): Queue<DeadLetterPayload> =>
  new Queue<DeadLetterPayload>(DEAD_LETTER_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      removeOnComplete: { count: 5_000 },
      removeOnFail: { count: 5_000 },
    },
  });

export type FailedHandlerDeps = {
  deadLetterQueue: Queue<DeadLetterPayload>;
  logger: { error: (obj: object, msg?: string) => void };
};

export const attachFailedHandler = <T = unknown>(
  worker: Worker<T>,
  queueName: string,
  deps: FailedHandlerDeps
): void => {
  worker.on('failed', async (job: Job<T> | undefined, err: Error) => {
    deps.logger.error(
      {
        jobId: job?.id,
        jobName: job?.name,
        queue: queueName,
        attemptsMade: job?.attemptsMade,
        maxAttempts: job?.opts.attempts,
        err: err.message,
      },
      'job_failed'
    );
    captureException(err, { route: `queue:${queueName}` });

    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) return;

    try {
      await deps.deadLetterQueue.add('replay', {
        originalQueue: queueName,
        originalJobId: job.id,
        originalJobName: job.name,
        data: job.data,
        failedReason: err.message,
        attemptsMade: job.attemptsMade,
        failedAt: new Date().toISOString(),
      });
    } catch (dlqError) {
      deps.logger.error(
        {
          jobId: job.id,
          queue: queueName,
          dlqError: dlqError instanceof Error ? dlqError.message : 'unknown',
        },
        'dlq_enqueue_failed'
      );
    }
  });
};
