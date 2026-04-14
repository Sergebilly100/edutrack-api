import 'fastify';

import type { AccessTokenClaims } from '../../modules/auth/auth.service.js';
import type { TenantDb } from '../database/db.js';

declare module 'fastify' {
  interface FastifyRequest {
    claims?: AccessTokenClaims;
    auth?: AccessTokenClaims;
    user: { userId: string; schemaName: string } | null;
    db: TenantDb | null;
    tenantDbRelease: (() => void) | null;
  }
}
