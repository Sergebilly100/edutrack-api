import { on } from '../../shared/events/event-bus.js';
import { withTenantSchema } from '../../shared/database/db.js';
import { logger } from '../../shared/observability/logger.js';
import { isWebPushConfigured } from '../../shared/push/web-push.js';

import { PushRepository } from './push.repository.js';
import { sendPushToSubscriber } from './push.service.js';

/**
 * Branche le Web Push sur les events métier existants. Le push COMPLÈTE les
 * SMS/email (il ne les remplace pas) : tout échec est non bloquant. Si les clés
 * VAPID ne sont pas configurées, les listeners sont des no-op.
 *
 * Destinataires (zones prioritaires) :
 *  - prof   : validation de présence approuvée / refusée
 *  - parent : élève absent
 */
export const registerPushEventListeners = (): void => {
  if (!isWebPushConfigured()) {
    logger.info('[push] listeners disabled (web-push not configured)');
    return;
  }

  on('teacher.attendance_approved', (payload) => {
    void sendPushToSubscriber({
      schemaName: payload.schemaName,
      subscriberType: 'user',
      subscriberId: payload.teacherUserId,
      payload: {
        title: 'Présence validée',
        body: `Votre cours ${payload.courseName} du ${payload.date} a été validé.`,
        url: '/attendance',
        tag: `validation-${payload.attendanceId}`,
      },
    });
  });

  on('teacher.attendance_rejected', (payload) => {
    void sendPushToSubscriber({
      schemaName: payload.schemaName,
      subscriberType: 'user',
      subscriberId: payload.teacherUserId,
      payload: {
        title: 'Présence refusée',
        body: `Votre cours ${payload.courseName} du ${payload.date} a été refusé : ${payload.reason}`,
        url: '/attendance',
        tag: `validation-${payload.attendanceId}`,
      },
    });
  });

  on('student.absent', (payload) => {
    void (async () => {
      try {
        const parentIds = await withTenantSchema(payload.schemaName, (tenantDb) =>
          new PushRepository(tenantDb).listParentIdsForStudent(payload.studentId)
        );
        await Promise.all(
          parentIds.map((parentId) =>
            sendPushToSubscriber({
              schemaName: payload.schemaName,
              subscriberType: 'parent',
              subscriberId: parentId,
              payload: {
                title: 'Absence signalée',
                body: `${payload.studentFirstName} a été noté(e) absent(e) en ${payload.subject} le ${payload.date}.`,
                url: '/parent',
                tag: `absence-${payload.studentId}-${payload.date}`,
              },
            })
          )
        );
      } catch (error) {
        logger.warn(
          { err: error instanceof Error ? error.message : 'unknown', schemaName: payload.schemaName },
          '[push] student.absent listener failed (non-blocking)'
        );
      }
    })();
  });

  logger.info('[push] event listeners registered');
};
