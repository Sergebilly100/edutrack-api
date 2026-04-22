import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const parsePayload = (payload: unknown): unknown => {
  if (typeof payload === 'string') {
    try {
      return JSON.parse(payload);
    } catch {
      return undefined;
    }
  }

  return payload;
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value === 'object' && value !== null) {
    return value as Record<string, unknown>;
  }

  return null;
};

const normalizeUuid = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!UUID_REGEX.test(trimmed)) {
    return null;
  }

  return trimmed;
};

const collectTenantIdsFromPayload = (payload: unknown): string[] => {
  const ids = new Set<string>();
  const parsed = parsePayload(payload);
  const objectPayload = asRecord(parsed);

  const directTenantId = normalizeUuid(objectPayload?.tenantId);
  if (directTenantId) {
    ids.add(directTenantId);
  }

  const tenantObject = asRecord(objectPayload?.tenant);
  const tenantObjectId = normalizeUuid(tenantObject?.id);
  if (tenantObjectId) {
    ids.add(tenantObjectId);
  }

  const tenants = Array.isArray(objectPayload?.tenants)
    ? (objectPayload?.tenants as unknown[])
    : [];

  for (const item of tenants) {
    const tenantRow = asRecord(item);
    const id = normalizeUuid(tenantRow?.id);
    if (id) {
      ids.add(id);
    }
  }

  return [...ids];
};

const extractTenantIds = (request: FastifyRequest, payload: unknown): string[] => {
  const ids = new Set<string>();

  const params = asRecord(request.params);
  const paramsIds = [params?.id, params?.tenantId];
  for (const value of paramsIds) {
    const normalized = normalizeUuid(value);
    if (normalized) {
      ids.add(normalized);
    }
  }

  const body = asRecord(request.body);
  const bodyTenantId = normalizeUuid(body?.tenantId);
  if (bodyTenantId) {
    ids.add(bodyTenantId);
  }

  for (const payloadTenantId of collectTenantIdsFromPayload(payload)) {
    ids.add(payloadTenantId);
  }

  return [...ids];
};

const trimAction = (action: string): string => {
  return action.length > 100 ? action.slice(0, 100) : action;
};

export const adminAuditOnSend = async (
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown
): Promise<unknown> => {
  if (!request.url.startsWith('/api/v1/admin')) {
    return payload;
  }

  if (reply.statusCode >= 400) {
    return payload;
  }

  const adminId = request.auth?.sub;
  if (!adminId || !request.db) {
    return payload;
  }

  try {
    const tenantIds = extractTenantIds(request, payload);
    if (tenantIds.length === 0) {
      return payload;
    }

    const action = trimAction(`${request.method} ${request.url}`);
    for (const tenantId of tenantIds) {
      await request.db.execute(sql`
        INSERT INTO public.admin_access_log (admin_id, tenant_id, action, ip_address)
        VALUES (${adminId}, ${tenantId}, ${action}, ${request.ip})
      `);
    }
  } catch (error) {
    request.log.error({ error }, '[admin-audit] failed to persist admin access log');
  }

  return payload;
};
