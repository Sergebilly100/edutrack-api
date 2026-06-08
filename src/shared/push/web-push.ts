import webpush from 'web-push';

import { logger } from '../observability/logger.js';

let configured = false;

/**
 * Initialise les clés VAPID. Sans configuration, le push est désactivé
 * silencieusement (les SMS/email restent le canal fiable) plutôt que de faire
 * planter le serveur - le push est un complément, pas une dépendance dure.
 */
export const initWebPush = (): void => {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim() || 'mailto:contact@ivoiredu.ci';

  if (!publicKey || !privateKey) {
    logger.warn('[web-push] VAPID keys missing - push notifications disabled');
    configured = false;
    return;
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  logger.info('[web-push] configured');
};

export const isWebPushConfigured = (): boolean => configured;

export type WebPushSubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

export type WebPushPayload = {
  title: string;
  body: string;
  /** URL ouverte au clic sur la notification. */
  url?: string;
  tag?: string;
};

export type SendPushResult =
  | { ok: true }
  | { ok: false; gone: boolean; error: string };

/**
 * Envoie une notification push à un abonnement.
 * `gone = true` signale un abonnement expiré/révoqué (404/410) : l'appelant doit
 * le supprimer de la base.
 */
export const sendPush = async (
  subscription: WebPushSubscription,
  payload: WebPushPayload
): Promise<SendPushResult> => {
  if (!configured) {
    return { ok: false, gone: false, error: 'web-push not configured' };
  }

  try {
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: subscription.keys,
      },
      JSON.stringify(payload),
      { TTL: 60 * 60 } // 1h : au-delà, l'info d'absence/validation est périmée
    );
    return { ok: true };
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    const gone = statusCode === 404 || statusCode === 410;
    return {
      ok: false,
      gone,
      error: error instanceof Error ? error.message : 'unknown push error',
    };
  }
};
