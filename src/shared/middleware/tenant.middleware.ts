import type { FastifyReply, FastifyRequest } from 'fastify';

import { acquireTenantDb } from '../database/db.js';
import { getTenantStatus } from '../cache/tenant-status.js';

const SCHEMA_NAME_REGEX = /^[a-z][a-z0-9_]{2,63}$/;

const BLOCKING_STATUSES = new Set(['suspended', 'cancelled']);

const badRequest = (reply: FastifyReply): FastifyReply => {
  return reply.code(400).send({
    error: 'Invalid or missing x-tenant-schema header',
    code: 'BAD_REQUEST',
    statusCode: 400,
  });
};

const tenantSuspended = (reply: FastifyReply, status: string): FastifyReply => {
  return reply.code(403).send({
    error: status === 'cancelled' ? 'Tenant cancelled' : 'Tenant suspended',
    code: 'TENANT_SUSPENDED',
    statusCode: 403,
    redirect: '/maintenance',
  });
};

const ensureTenantOperational = async (
  request: FastifyRequest,
  reply: FastifyReply,
  schemaName: string
): Promise<boolean> => {
  const url = request.url.split('?')[0] ?? '';
  if (
    url.startsWith('/api/v1/auth/me') ||
    url.startsWith('/api/v1/auth/logout') ||
    url.startsWith('/api/v1/auth/refresh')
  ) {
    return true;
  }
  const status = await getTenantStatus(schemaName);
  if (status && BLOCKING_STATUSES.has(status)) {
    tenantSuspended(reply, status);
    return false;
  }
  return true;
};

export const attachTenantDb = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => {
  request.db = null;
  request.tenantDbRelease = null;

  const schemaFromJwt = request.claims?.schemaName?.trim();
  if (schemaFromJwt && SCHEMA_NAME_REGEX.test(schemaFromJwt)) {
    if (!(await ensureTenantOperational(request, reply, schemaFromJwt))) return;
    const tenant = await acquireTenantDb(schemaFromJwt);
    request.db = tenant.db;
    request.tenantDbRelease = tenant.release;
    return;
  }

  const headerValue = request.headers['x-tenant-schema'];
  if (typeof headerValue !== 'string') {
    void badRequest(reply);
    return;
  }

  const schemaName = headerValue.trim();
  if (!SCHEMA_NAME_REGEX.test(schemaName)) {
    void badRequest(reply);
    return;
  }

  if (!(await ensureTenantOperational(request, reply, schemaName))) return;
  const tenant = await acquireTenantDb(schemaName);
  request.db = tenant.db;
  request.tenantDbRelease = tenant.release;
};

export const attachPublicDb = async (request: FastifyRequest): Promise<void> => {
  request.db = null;
  request.tenantDbRelease = null;

  const tenant = await acquireTenantDb('public');
  request.db = tenant.db;
  request.tenantDbRelease = tenant.release;
};

export const releaseTenantDb = async (request: FastifyRequest): Promise<void> => {
  if (request.tenantDbRelease) {
    request.tenantDbRelease();
    request.tenantDbRelease = null;
  }

  request.db = null;
};
