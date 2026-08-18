import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { ZodError, z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';

import { db as publicDb, withTenantSchema } from '../../shared/database/db.js';
import {
  authenticateRequest,
  requireDirector,
  requirePermission,
  requireTeacher,
} from '../../shared/middleware/auth.middleware.js';
import type { NotificationType } from '../../shared/types/index.js';

import { SENSITIVE_ACTION_RATE_LIMIT } from '../../shared/utils/rate-limit.js';
import { defaultRepository } from './notifications.repository.js';
import type { NotificationJobData } from './notifications.queue.js';

const notificationTypes: NotificationType[] = [
  'teacher_absent_director',
  'teacher_late_director',
  'teacher_qr_mismatch',
  'teacher_qr_missing_scan',
  'teacher_qr_scan_out_of_time',
  'qr_invalid_alert',
  'student_absent_parent',
  'attendance_rejected',
  'attendance_approved',
  'scan_end_warning',
  'scan_end_sanction',
  'scan_end_sanction_cancelled',
  'subscription_expiry_alert',
  'subscription_revenue_payout',
  'parent_access_credentials',
  'payment_reminder',
  'custom',
];

const notificationTypeSet = new Set(notificationTypes);
const SMS_TEMPLATE_STUDENT_ABSENT_TYPE = 'student_absent_parent';
const DEFAULT_STUDENT_ABSENT_TEMPLATE =
  'IvoirEdu: {studentFirstName} absent(e) en {subject} le {date}. Connectez-vous à votre espace parent pour plus d\'informations. \nContact école: {schoolPhone}';

const schoolTemplateBodySchema = z.object({
  message_template: z.string().trim().min(5).max(500),
  variables: z.array(z.string().trim().min(1).max(60)).default([]),
});

const toPgTextArrayLiteral = (values: readonly string[]): string => {
  if (values.length === 0) {
    return '{}';
  }

  const escaped = values.map((value) => {
    const sanitized = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${sanitized}"`;
  });

  return `{${escaped.join(',')}}`;
};

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  offset: z.coerce.number().int().min(0).default(0),
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

const retryParamsSchema = z.object({ id: z.uuid() });

type NotificationsControllerOptions = {
  smsQueue?: Queue<NotificationJobData>;
};

export default async function notificationsController(
  app: FastifyInstance,
  options: NotificationsControllerOptions = {}
): Promise<void> {
  app.post(
    '/api/v1/notifications/:id/retry',
    {
      // Met un SMS en queue (coût réel) → rate-limit dédié.
      config: { rateLimit: SENSITIVE_ACTION_RATE_LIMIT },
      preHandler: async (request, reply) => {
        await authenticateRequest(request, reply);
        if (reply.sent) return;
        // Le directeur peut retry n'importe quel SMS de son école ; les autres rôles
        // doivent avoir explicitement la permission students.excuse (cas des SMS parents).
        if (request.claims?.role === 'director') {
          return;
        }
        return requirePermission('students.excuse')(request, reply);
      },
    },
    async (request, reply) => {
      if (!options.smsQueue) {
        return reply.code(503).send({
          error: 'SMS queue not available',
          code: 'SERVICE_UNAVAILABLE',
          statusCode: 503,
        });
      }

      try {
        const claims = request.claims!;
        const params = retryParamsSchema.parse(request.params ?? {});

        const row = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          const result = await (tenantDb as { execute: <T>(q: unknown) => Promise<{ rows: T[] }> }).execute<{
            id: string;
            type: string;
            channel: string;
            message: string;
            recipient_phone: string | null;
            related_id: string | null;
            status: string;
          }>(sql`
            SELECT id::text, type::text, channel::text, message, recipient_phone,
                   related_id::text AS related_id, status::text
            FROM notifications_log
            WHERE id = ${params.id}::uuid
            LIMIT 1
          `);
          return result.rows[0] ?? null;
        });

        if (!row) {
          return reply.code(404).send({ error: 'Notification not found', code: 'NOT_FOUND', statusCode: 404 });
        }

        if (row.status !== 'failed') {
          return reply.code(409).send({ error: 'Only failed notifications can be retried', code: 'INVALID_STATUS', statusCode: 409 });
        }

        if (row.channel !== 'sms' || !row.recipient_phone) {
          return reply.code(422).send({ error: 'Only SMS notifications can be retried', code: 'UNPROCESSABLE', statusCode: 422 });
        }

        const queueRef = randomUUID();

        await withTenantSchema(claims.schemaName, async (tenantDb) => {
          await (tenantDb as { execute: (q: unknown) => Promise<unknown> }).execute(sql`
            UPDATE notifications_log
            SET status = 'queued', provider_ref = ${queueRef}, sent_at = NULL
            WHERE id = ${params.id}::uuid
          `);
        });

        await options.smsQueue!.add('send-sms', {
          type: 'send-sms',
          to: row.recipient_phone,
          message: row.message,
          notificationType: row.type as NotificationType,
          schemaName: claims.schemaName,
          recipientPhone: row.recipient_phone,
          queueRef,
          ...(row.type === 'parent_access_credentials' && row.related_id
            ? { parentAccessSentUpdate: { parentId: row.related_id } }
            : {}),
        });

        return reply.send({ success: true, queueRef });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get('/api/v1/notifications/log', { preHandler: requireDirector }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const query = querySchema.parse(request.query ?? {});

      const data = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        return defaultRepository.listNotificationLog(tenantDb, {
          limit: query.limit,
          offset: query.offset,
          types: query.types,
        });
      });

      return reply.send(data);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.get('/api/v1/notifications/me', { preHandler: requireTeacher }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const data = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        return defaultRepository.listTeacherNotifications(tenantDb, {
          userId: claims.sub,
          limit: 20,
        });
      });

      return reply.send(data);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.get(
    '/api/v1/notifications/templates/student-absence',
    { preHandler: requirePermission('settings.sms_templates') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        if (claims.role !== 'director' && claims.role !== 'staff') {
          return reply.code(403).send({
            error: 'Permission settings.sms_templates required',
            code: 'FORBIDDEN',
            statusCode: 403,
          });
        }

        const tenantResult = await publicDb.execute<{
          id: string;
          can_edit_sms_template: boolean;
        }>(sql`
          SELECT id::text, COALESCE(can_edit_sms_template, false) AS can_edit_sms_template
          FROM public.tenants
          WHERE schema_name = ${claims.schemaName}
          LIMIT 1
        `);
        const tenant = tenantResult.rows[0];
        if (!tenant) {
          return reply.code(404).send({
            error: 'Tenant not found',
            code: 'NOT_FOUND',
            statusCode: 404,
          });
        }

        const globalTemplateResult = await publicDb.execute<{
          message_template: string;
          variables: string[] | null;
          updated_at: string | null;
        }>(sql`
          SELECT message_template, variables, updated_at::text
          FROM public.sms_templates
          WHERE tenant_id IS NULL
            AND type = ${SMS_TEMPLATE_STUDENT_ABSENT_TYPE}
          ORDER BY updated_at DESC
          LIMIT 1
        `);

        const schoolTemplateResult = await publicDb.execute<{
          message_template: string;
          variables: string[] | null;
          updated_at: string | null;
        }>(sql`
          SELECT message_template, variables, updated_at::text
          FROM public.sms_templates
          WHERE tenant_id = ${tenant.id}::uuid
            AND type = ${SMS_TEMPLATE_STUDENT_ABSENT_TYPE}
          ORDER BY updated_at DESC
          LIMIT 1
        `);

        const schoolTemplate = schoolTemplateResult.rows[0];
        const globalTemplate = globalTemplateResult.rows[0];
        const source = schoolTemplate
          ? 'school'
          : globalTemplate
            ? 'global'
            : 'default';
        const messageTemplate =
          schoolTemplate?.message_template ??
          globalTemplate?.message_template ??
          DEFAULT_STUDENT_ABSENT_TEMPLATE;
        const variables = schoolTemplate?.variables ?? globalTemplate?.variables ?? [];
        const updatedAt = schoolTemplate?.updated_at ?? globalTemplate?.updated_at ?? null;

        return reply.send({
          enabledBySuperAdmin: tenant.can_edit_sms_template,
          source,
          messageTemplate,
          variables,
          updatedAt,
        });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.put(
    '/api/v1/notifications/templates/student-absence',
    { preHandler: requirePermission('settings.sms_templates') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        if (claims.role !== 'director' && claims.role !== 'staff') {
          return reply.code(403).send({
            error: 'Permission settings.sms_templates required',
            code: 'FORBIDDEN',
            statusCode: 403,
          });
        }

        const body = schoolTemplateBodySchema.parse(request.body ?? {});
        const tenantResult = await publicDb.execute<{
          id: string;
          can_edit_sms_template: boolean;
        }>(sql`
          SELECT id::text, COALESCE(can_edit_sms_template, false) AS can_edit_sms_template
          FROM public.tenants
          WHERE schema_name = ${claims.schemaName}
          LIMIT 1
        `);
        const tenant = tenantResult.rows[0];
        if (!tenant) {
          return reply.code(404).send({
            error: 'Tenant not found',
            code: 'NOT_FOUND',
            statusCode: 404,
          });
        }
        if (!tenant.can_edit_sms_template) {
          return reply.code(403).send({
            error: "La personnalisation des templates SMS n'est pas autorisée pour cette école",
            code: 'FORBIDDEN',
            statusCode: 403,
          });
        }

        await publicDb.execute(sql`
          INSERT INTO public.sms_templates (tenant_id, type, message_template, variables, created_by, updated_at)
          VALUES (
            ${tenant.id}::uuid,
            ${SMS_TEMPLATE_STUDENT_ABSENT_TYPE},
            ${body.message_template},
            CAST(${toPgTextArrayLiteral(body.variables)} AS text[]),
            ${claims.sub}::uuid,
            NOW()
          )
          ON CONFLICT (tenant_id, type)
          DO UPDATE SET
            message_template = EXCLUDED.message_template,
            variables = EXCLUDED.variables,
            updated_at = NOW()
        `);

        return reply.send({ success: true });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.delete(
    '/api/v1/notifications/templates/student-absence',
    { preHandler: requirePermission('settings.sms_templates') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        if (claims.role !== 'director' && claims.role !== 'staff') {
          return reply.code(403).send({
            error: 'Permission settings.sms_templates required',
            code: 'FORBIDDEN',
            statusCode: 403,
          });
        }

        const tenantResult = await publicDb.execute<{
          id: string;
          can_edit_sms_template: boolean;
        }>(sql`
          SELECT id::text, COALESCE(can_edit_sms_template, false) AS can_edit_sms_template
          FROM public.tenants
          WHERE schema_name = ${claims.schemaName}
          LIMIT 1
        `);
        const tenant = tenantResult.rows[0];
        if (!tenant) {
          return reply.code(404).send({
            error: 'Tenant not found',
            code: 'NOT_FOUND',
            statusCode: 404,
          });
        }
        if (!tenant.can_edit_sms_template) {
          return reply.code(403).send({
            error: "La personnalisation des templates SMS n'est pas autorisée pour cette école",
            code: 'FORBIDDEN',
            statusCode: 403,
          });
        }

        await publicDb.execute(sql`
          DELETE FROM public.sms_templates
          WHERE tenant_id = ${tenant.id}::uuid
            AND type = ${SMS_TEMPLATE_STUDENT_ABSENT_TYPE}
        `);

        return reply.send({ success: true });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );
}
