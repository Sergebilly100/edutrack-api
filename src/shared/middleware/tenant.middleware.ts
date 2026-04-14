import type { FastifyReply, FastifyRequest } from 'fastify';

import { acquireTenantDb } from '../database/db.js';

const SCHEMA_NAME_REGEX = /^[a-z][a-z0-9_]{2,63}$/;

const badRequest = (reply: FastifyReply): FastifyReply => {
  return reply.code(400).send({
    error: 'Invalid or missing x-tenant-schema header',
    code: 'BAD_REQUEST',
    statusCode: 400,
  });
};

export const attachTenantDb = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => {
  request.db = null;
  request.tenantDbRelease = null;

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
