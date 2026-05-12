import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { ZodError, z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';

import { db as publicDb, withTenantSchema } from '../../shared/database/db.js';
import { requireDirector, requirePermission, requireTeacher } from '../../shared/middleware/auth.middleware.js';
import type { NotificationType } from '../../shared/types/index.js';

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
  'payment_reminder',
  'custom',
];

const notificationTypeSet = new Set(notificationTypes);
const SMS_TEMPLATE_STUDENT_ABSENT_TYPE = 'student_absent_parent';
const DEFAULT_STUDENT_ABSENT_TEMPLATE =
  'EduTrack: {studentFirstName} absent(e) en {subject} le {date}. Contact école: {schoolPhone}';

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

const orangeDeliveryStatusSchema = z.enum([
  'DeliveredToNetwork',
  'DeliveryUncertain',
  'DeliveryImpossible',
  'MessageWaiting',
  'DeliveredToTerminal',
]);

const orangeDeliveryReceiptSchema = z.object({
  deliveryInfoNotification: z.object({
    callbackData: z.string().trim().min(1),
    deliveryInfo: z.object({
      address: z.string().trim().min(1),
      deliveryStatus: orangeDeliveryStatusSchema,
    }),
  }),
});

const orangeTestSendBodySchema = z.object({
  tokenUrl: z.string().trim().url().default('https://api.orange.com/oauth/v3/token'),
  smsBaseUrl: z.string().trim().url().default('https://api.orange.com/smsmessaging/v1/outbound'),
  clientId: z.string().trim().min(1),
  clientSecret: z.string().trim().min(1),
  senderAddress: z.string().trim().min(1),
  senderName: z.string().trim().optional().default(''),
  recipient: z.string().trim().min(1),
  message: z.string().trim().min(1).max(1000),
  notifyUrl: z.string().trim().url().optional().or(z.literal('')).default(''),
  callbackData: z.string().trim().optional().default(''),
});

const mapOrangeDeliveryStatus = (
  deliveryStatus: z.infer<typeof orangeDeliveryStatusSchema>
): 'sent' | 'failed' | 'delivered' => {
  if (deliveryStatus === 'DeliveredToTerminal') {
    return 'delivered';
  }

  if (deliveryStatus === 'DeliveryImpossible') {
    return 'failed';
  }

  return 'sent';
};

const normalizeSmsPhone = (phone: string): string => {
  const digits = phone.replace(/\D/g, '');
  if (!digits) return phone;
  if (digits.startsWith('225')) return `+${digits}`;
  if (digits.startsWith('0') && digits.length === 10) return `+225${digits}`;
  if (digits.length === 8 || digits.length === 10) return `+225${digits}`;
  return phone.trim().startsWith('+') ? phone.trim() : `+${digits}`;
};

const readJsonOrText = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

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
  app.post('/api/v1/notifications/orange/test-send', async (request, reply) => {
    try {
      if (process.env.NODE_ENV === 'production') {
        return reply.code(404).send({
          error: 'Not found',
          code: 'NOT_FOUND',
          statusCode: 404,
        });
      }

      const body = orangeTestSendBodySchema.parse(request.body ?? {});
      const basicCredentials = Buffer.from(`${body.clientId}:${body.clientSecret}`).toString('base64');
      const tokenResponse = await fetch(body.tokenUrl, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicCredentials}`,
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      });
      const tokenPayload = (await readJsonOrText(tokenResponse)) as { access_token?: string } | string | null;
      if (!tokenResponse.ok || typeof tokenPayload !== 'object' || !tokenPayload?.access_token) {
        return reply.code(502).send({
          success: false,
          step: 'token',
          token: {
            status: tokenResponse.status,
            response: tokenPayload,
          },
        });
      }

      const senderAddress = `tel:${normalizeSmsPhone(body.senderAddress)}`;
      const recipient = normalizeSmsPhone(body.recipient);
      const smsBaseUrl = body.smsBaseUrl.replace(/\/+$/, '');
      const outboundBaseUrl = /\/outbound$/.test(smsBaseUrl)
        ? smsBaseUrl
        : `${smsBaseUrl}/outbound`;
      const smsUrl = `${outboundBaseUrl}/${encodeURIComponent(senderAddress)}/requests`;
      const smsBody: {
        outboundSMSMessageRequest: {
          address: string;
          senderAddress: string;
          outboundSMSTextMessage: { message: string };
          senderName?: string;
          receiptRequest?: {
            notifyURL: string;
            callbackData: string;
          };
        };
      } = {
        outboundSMSMessageRequest: {
          address: `tel:${recipient}`,
          senderAddress,
          outboundSMSTextMessage: {
            message: body.message,
          },
        },
      };
      if (body.senderName) {
        smsBody.outboundSMSMessageRequest.senderName = body.senderName;
      }
      if (body.notifyUrl) {
        smsBody.outboundSMSMessageRequest.receiptRequest = {
          notifyURL: body.notifyUrl,
          callbackData: body.callbackData || randomUUID(),
        };
      }

      const smsResponse = await fetch(smsUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenPayload.access_token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(smsBody),
      });
      const smsPayload = await readJsonOrText(smsResponse);

      return reply.code(smsResponse.ok ? 200 : 502).send({
        success: smsResponse.ok,
        token: {
          status: tokenResponse.status,
          response: {
            access_token: '<redacted>',
          },
        },
        sms: {
          url: smsUrl,
          status: smsResponse.status,
          request: smsBody,
          response: smsPayload,
        },
      });
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.post('/api/v1/notifications/orange/delivery-receipt', async (request, reply) => {
    try {
      const body = orangeDeliveryReceiptSchema.parse(request.body ?? {});
      const callbackData = body.deliveryInfoNotification.callbackData;
      const deliveryStatus = body.deliveryInfoNotification.deliveryInfo.deliveryStatus;
      const status = mapOrangeDeliveryStatus(deliveryStatus);

      const tenantsResult = await publicDb.execute<{ schema_name: string }>(sql`
        SELECT schema_name
        FROM public.tenants
        WHERE status IN ('trial', 'active', 'suspended')
        ORDER BY created_at ASC
      `);

      let updated = 0;
      for (const tenant of tenantsResult.rows) {
        updated += await withTenantSchema(tenant.schema_name, async (tenantDb) => {
          return defaultRepository.updateNotificationLogDeliveryStatus(tenantDb, {
            providerRef: callbackData,
            status,
          });
        });
      }

      request.log.info(
        {
          provider: 'orange_api',
          callbackData,
          deliveryStatus,
          status,
          updated,
        },
        '[notifications] orange delivery receipt received'
      );

      return reply.send({ success: true, updated });
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.post(
    '/api/v1/notifications/:id/retry',
    { preHandler: requirePermission('students.excuse') },
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
            status: string;
          }>(sql`
            SELECT id::text, type::text, channel::text, message, recipient_phone, status::text
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
