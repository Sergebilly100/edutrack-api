import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';

import { withTenantSchema } from '../../shared/database/db.js';
import { requireDirector } from '../../shared/middleware/auth.middleware.js';
import type { NotificationType } from '../../shared/types/index.js';

import { defaultRepository } from './notifications.repository.js';

const notificationTypes: NotificationType[] = [
  'teacher_absent_director',
  'teacher_late_director',
  'teacher_qr_mismatch',
  'teacher_qr_missing_scan',
  'teacher_qr_scan_out_of_time',
  'student_absent_parent',
  'payment_reminder',
  'custom',
];

const notificationTypeSet = new Set(notificationTypes);

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  types: z
    .string()
    .optional()
    .transform((value) => {
      if (!value || value.trim().length === 0) {
        return undefined;
      }

      const parsed = value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);

      if (parsed.some((item) => !notificationTypeSet.has(item as NotificationType))) {
        throw new Error('Invalid notification type');
      }

      return parsed as NotificationType[];
    }),
});

const handleError = (
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown
): FastifyReply => {
  if (error instanceof ZodError || (error instanceof Error && error.message === 'Invalid notification type')) {
    return reply.code(400).send({
      error: 'Validation error',
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
  }

  request.log.error(
    { err: error instanceof Error ? error.message : 'unknown error' },
    '[notifications] unhandled error'
  );

  return reply.code(500).send({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
    statusCode: 500,
  });
};

export default async function notificationsController(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/notifications/log', { preHandler: requireDirector }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const query = querySchema.parse(request.query ?? {});

      const data = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        return defaultRepository.listNotificationLog(tenantDb, {
          limit: query.limit,
          types: query.types,
        });
      });

      return reply.send(data);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });
}
