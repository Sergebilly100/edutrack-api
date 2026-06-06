/**
 * Process a list of items in batches with bounded concurrency.
 *
 * Use Promise.allSettled within each batch so a failure in one tenant doesn't
 * abort the whole pass - the `onError` callback receives the exception so the
 * caller can log it through the request/app logger.
 *
 * Batch size keeps the DB pool from being saturated by N parallel tenants.
 */
export const processInBatches = async <T>(
  items: readonly T[],
  batchSize: number,
  task: (item: T) => Promise<void>,
  onError?: (item: T, error: unknown) => void
): Promise<void> => {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map(task));
    results.forEach((result, idx) => {
      if (result.status === 'rejected') {
        onError?.(batch[idx]!, result.reason);
      }
    });
  }
};
