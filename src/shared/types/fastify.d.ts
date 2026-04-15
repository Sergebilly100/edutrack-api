import 'fastify';

import type { AccessTokenClaims } from '../../modules/auth/auth.service.js';
import type { TenantDb } from '../database/db.js';
import type { PermissionKey } from './index.js';

declare module 'fastify' {
  interface FastifyRequest {
    claims?: AccessTokenClaims;
    auth?: AccessTokenClaims;
    permissions?: Set<PermissionKey>;
    user: { userId: string; schemaName: string } | null;
    db: TenantDb | null;
    tenantDbRelease: (() => void) | null;
  }
}
