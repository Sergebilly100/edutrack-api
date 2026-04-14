export type MissingQrScanDetectionHandler = (params: {
  schemaName: string;
  date?: string;
}) => Promise<number>;

/**
 * Détection absence (+15 min) conservée côté job existant.
 * Ce worker ajoute la détection QR manquant (+20 min)
 * quand un check-in existe sans room_scan_start_at.
 */
export const runMissingQrScanDetection = async (
  params: {
    schemaName: string;
    date?: string;
  },
  handler: MissingQrScanDetectionHandler
): Promise<{ detected: number }> => {
  const detected = await handler(params);
  return { detected };
};
