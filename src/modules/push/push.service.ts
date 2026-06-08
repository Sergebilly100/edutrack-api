import { withTenantSchema } from '../../shared/database/db.js';
import { logger } from '../../shared/observability/logger.js';
import { isWebPushConfigured, sendPush, type WebPushPayload } from '../../shared/push/web-push.js';

import { PushRepository, type SubscriberType } from './push.repository.js';

/**
 * Envoie une notification push à tous les appareils d'un destinataire dans un
 * tenant donné. Best-effort : le push complète les SMS/email, donc un échec
 * (device hors-ligne, web-push non configuré) ne doit jamais faire échouer le
 * traitement appelant. Les abonnements expirés (404/410) sont nettoyés.
 */
export const sendPushToSubscriber = async (input: {
  schemaName: string;
  subscriberType: SubscriberType;
  subscriberId: string;
  payload: WebPushPayload;
}): Promise<{ sent: number }> => {
  if (!isWebPushConfigured()) {
    return { sent: 0 };
  }

  try {
    return await withTenantSchema(input.schemaName, async (tenantDb) => {
      const repository = new PushRepository(tenantDb);
      const subscriptions = await repository.listForSubscriber(
        input.subscriberType,
        input.subscriberId
      );
      if (subscriptions.length === 0) {
        return { sent: 0 };
      }

      let sent = 0;
      for (const sub of subscriptions) {
        const result = await sendPush(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          input.payload
        );
        if (result.ok) {
          sent += 1;
        } else if (result.gone) {
          await repository.deleteByEndpoint(sub.endpoint).catch(() => {
            /* nettoyage best-effort */
          });
        }
      }
      return { sent };
    });
  } catch (error) {
    logger.warn(
      {
        err: error instanceof Error ? error.message : 'unknown',
        schemaName: input.schemaName,
        subscriberType: input.subscriberType,
      },
      '[push] failed to send (non-blocking)'
    );
    return { sent: 0 };
  }
};
