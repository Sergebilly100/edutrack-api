import { qrAlertQueue } from '../../shared/queue/queue.js';

export const scheduleQrMissingScanCheck = async (params: {
  schemaName: string;
  scheduleId: string;
  date: string;
  slotStartTimeUtc: string;
}): Promise<void> => {
  const scheduledAt =
    new Date(`${params.date}T${params.slotStartTimeUtc}.000Z`).getTime() + 20 * 60000;
  const delay = scheduledAt - Date.now();

  if (delay < 0) {
    return;
  }

  await qrAlertQueue.add(
    'attendance.qr-missing-scan-check',
    {
      schemaName: params.schemaName,
      scheduleId: params.scheduleId,
      date: params.date,
      slotStartTimeUtc: params.slotStartTimeUtc,
    },
    {
      delay,
      removeOnComplete: true,
      removeOnFail: true,
      jobId: `qr-missing:${params.schemaName}:${params.scheduleId}:${params.date}`,
    }
  );
};
