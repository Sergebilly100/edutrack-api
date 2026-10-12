import { describe, expect, it, vi } from 'vitest';
import type { Job, Queue, Worker } from 'bullmq';

vi.mock('../../src/shared/observability/sentry.js', () => ({ captureException: vi.fn() }));

import { attachFailedHandler, type DeadLetterPayload } from '../../src/shared/queue/dead-letter-queue.js';

describe('dead letter des accès parent', () => {
  it('ne recopie jamais le contenu du job ni son erreur dans la file persistante', async () => {
    let onFailed: ((job: Job<unknown>, error: Error) => Promise<void>) | undefined;
    const worker = {
      on: vi.fn((_event: string, handler: typeof onFailed) => { onFailed = handler; }),
    } as unknown as Worker<unknown>;
    const deadLetterQueue = { add: vi.fn().mockResolvedValue(undefined) } as unknown as Queue<DeadLetterPayload>;
    const logger = { error: vi.fn() };
    attachFailedHandler(worker, 'notifications-sms', { deadLetterQueue, logger });

    const job = {
      id: 'job-1', name: 'send-email', attemptsMade: 3, opts: { attempts: 3 },
      data: { notificationType: 'parent_access_credentials', text: 'Secret SAFE234567', to: 'parent@example.ci' },
    } as unknown as Job<unknown>;
    await onFailed!(job, new Error('Provider returned Secret SAFE234567'));
    const stored = vi.mocked(deadLetterQueue.add).mock.calls[0]?.[1];
    expect(stored?.data).toEqual({ notificationType: 'parent_access_credentials', redacted: true });
    expect(stored?.failedReason).toBe('Parent access delivery failed');
    expect(JSON.stringify(stored)).not.toContain('SAFE234567');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('SAFE234567');
  });
});
