import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';

export type QueryExecutor = {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
};

type AuthUserRow = {
  user_id: string;
  role: 'director' | 'staff' | 'teacher' | 'super_admin';
  name: string;
  phone: string | null;
  email: string | null;
  profile_photo_url: string | null;
  password_hash: string;
  is_active: boolean;
  teacher_id: string | null;
  username: string | null;
  keycloak_subject: string | null;
};

export type AuthUser = {
  userId: string;
  role: AuthUserRow['role'];
  name: string;
  phone: string | null;
  email: string | null;
  profilePhotoUrl: string | null;
  passwordHash: string;
  isActive: boolean;
  teacherId: string | null;
  username: string | null;
  keycloakSubject: string | null;
};

const mapAuthUser = (row: AuthUserRow): AuthUser => ({
  userId: row.user_id,
  role: row.role,
  name: row.name,
  phone: row.phone,
  email: row.email,
  profilePhotoUrl: row.profile_photo_url,
  passwordHash: row.password_hash,
  isActive: row.is_active,
  teacherId: row.teacher_id,
  username: row.username,
  keycloakSubject: row.keycloak_subject,
});

const getRows = (result: unknown): AuthUserRow[] => {
  if (typeof result !== 'object' || result === null || !('rows' in result)) {
    return [];
  }

  const rows = (result as { rows: AuthUserRow[] }).rows;
  return Array.isArray(rows) ? rows : [];
};

type ColumnRow = {
  column_name: string;
};

type RefreshTokenStateRow = {
  token_exists: boolean;
  is_active: boolean;
  not_expired: boolean;
};

type RefreshSessionRow = {
  id: string;
  user_id: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  user_agent: string | null;
  ip_address: string | null;
  token_hash: string;
};

const hashRefreshToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

const getColumnRows = (result: unknown): ColumnRow[] => {
  if (typeof result !== 'object' || result === null || !('rows' in result)) {
    return [];
  }

  const rows = (result as { rows: ColumnRow[] }).rows;
  return Array.isArray(rows) ? rows : [];
};

const getRefreshTokenStateRows = (result: unknown): RefreshTokenStateRow[] => {
  if (typeof result !== 'object' || result === null || !('rows' in result)) {
    return [];
  }

  const rows = (result as { rows: RefreshTokenStateRow[] }).rows;
  return Array.isArray(rows) ? rows : [];
};

const getRefreshSessionRows = (result: unknown): RefreshSessionRow[] => {
  if (typeof result !== 'object' || result === null || !('rows' in result)) {
    return [];
  }

  const rows = (result as { rows: RefreshSessionRow[] }).rows;
  return Array.isArray(rows) ? rows : [];
};

const baseSelect = sql`
  SELECT
    u.id AS user_id,
    u.role,
    u.name,
    u.phone,
    u.email,
    u.profile_photo_url,
    u.keycloak_subject,
    u.password_hash,
    u.is_active,
    t.id AS teacher_id,
    t.username
  FROM users u
  LEFT JOIN teachers t ON t.user_id = u.id
`;

const ensureUsersProfileColumns = async (db: QueryExecutor): Promise<void> => {
  await db.execute(sql`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS profile_photo_url text,
    ADD COLUMN IF NOT EXISTS keycloak_subject varchar(255)
  `);
};

const ensureRefreshTokensTable = async (db: QueryExecutor): Promise<void> => {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token text NOT NULL UNIQUE,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      expires_at timestamptz,
      user_agent text,
      ip_address text
    )
  `);

  await db.execute(sql`
    ALTER TABLE refresh_tokens
    ADD COLUMN IF NOT EXISTS user_agent text,
    ADD COLUMN IF NOT EXISTS ip_address text,
    ADD COLUMN IF NOT EXISTS last_used_at timestamptz
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_active
      ON refresh_tokens (user_id, is_active)
  `);
};

export const findUserByPhone = async (
  db: QueryExecutor,
  phone: string
): Promise<AuthUser | null> => {
  await ensureUsersProfileColumns(db);
  const result = await db.execute(sql`
    ${baseSelect}
    WHERE u.phone = ${phone}
    LIMIT 1
  `);

  const [row] = getRows(result);
  return row ? mapAuthUser(row) : null;
};

export const findUserByUsername = async (
  db: QueryExecutor,
  username: string
): Promise<AuthUser | null> => {
  await ensureUsersProfileColumns(db);
  const result = await db.execute(sql`
    ${baseSelect}
    WHERE t.username = ${username}
    LIMIT 1
  `);

  const [row] = getRows(result);
  return row ? mapAuthUser(row) : null;
};

export const findUserByEmail = async (
  db: QueryExecutor,
  email: string
): Promise<AuthUser | null> => {
  await ensureUsersProfileColumns(db);
  const result = await db.execute(sql`
    ${baseSelect}
    WHERE u.email = ${email}
    LIMIT 1
  `);

  const [row] = getRows(result);
  return row ? mapAuthUser(row) : null;
};

export const findUserProfileById = async (
  db: QueryExecutor,
  userId: string
): Promise<AuthUser | null> => {
  await ensureUsersProfileColumns(db);
  const result = await db.execute(sql`
    ${baseSelect}
    WHERE u.id = ${userId}
    LIMIT 1
  `);

  const [row] = getRows(result);
  return row ? mapAuthUser(row) : null;
};

export const updateLastLoginAt = async (
  db: QueryExecutor,
  userId: string
): Promise<void> => {
  await db.execute(sql`
    UPDATE users
    SET last_login_at = NOW()
    WHERE id = ${userId}
  `);
};

export const updateUserPasswordHash = async (
  db: QueryExecutor,
  userId: string,
  passwordHash: string
): Promise<void> => {
  await db.execute(sql`
    UPDATE users
    SET password_hash = ${passwordHash}
    WHERE id = ${userId}
  `);
};

export const updateUserProfile = async (
  db: QueryExecutor,
  userId: string,
  input: {
    name?: string;
    phone?: string | null;
    email?: string | null;
    profilePhotoUrl?: string | null;
  }
): Promise<void> => {
  await ensureUsersProfileColumns(db);
  await db.execute(sql`
    UPDATE users
    SET
      name = CASE WHEN ${input.name !== undefined} THEN ${input.name ?? null} ELSE name END,
      phone = CASE WHEN ${input.phone !== undefined} THEN ${input.phone ?? null} ELSE phone END,
      email = CASE WHEN ${input.email !== undefined} THEN ${input.email ?? null} ELSE email END,
      profile_photo_url = CASE
        WHEN ${input.profilePhotoUrl !== undefined}
          THEN ${input.profilePhotoUrl ?? null}
        ELSE profile_photo_url
      END
    WHERE id = ${userId}
  `);
};

export const bindKeycloakSubjectIfNeeded = async (
  db: QueryExecutor,
  userId: string,
  keycloakSubject: string
): Promise<void> => {
  await ensureUsersProfileColumns(db);
  await db.execute(sql`
    UPDATE users
    SET keycloak_subject = ${keycloakSubject}
    WHERE id = ${userId}
      AND keycloak_subject IS NULL
  `);
};

export const storeRefreshToken = async (
  db: QueryExecutor,
  input: {
    userId: string;
    token: string;
    expiresAt: string | null;
    userAgent?: string | null;
    ipAddress?: string | null;
  }
): Promise<void> => {
  await ensureRefreshTokensTable(db);
  const tokenHash = hashRefreshToken(input.token);
  await db.execute(sql`
    INSERT INTO refresh_tokens (
      user_id,
      token,
      is_active,
      updated_at,
      last_used_at,
      revoked_at,
      expires_at,
      user_agent,
      ip_address
    )
    VALUES (
      ${input.userId}::uuid,
      ${tokenHash},
      true,
      NOW(),
      NOW(),
      NULL,
      ${input.expiresAt ? sql`${input.expiresAt}::timestamptz` : sql`NULL`},
      ${input.userAgent ?? null},
      ${input.ipAddress ?? null}
    )
    ON CONFLICT (token)
    DO UPDATE SET
      user_id = EXCLUDED.user_id,
      is_active = true,
      updated_at = NOW(),
      last_used_at = NOW(),
      revoked_at = NULL,
      expires_at = EXCLUDED.expires_at,
      user_agent = EXCLUDED.user_agent,
      ip_address = EXCLUDED.ip_address
  `);
};

export type RefreshTokenStatus = 'active' | 'inactive' | 'missing';

export const getRefreshTokenStatus = async (
  db: QueryExecutor,
  token: string
): Promise<RefreshTokenStatus> => {
  await ensureRefreshTokensTable(db);
  const tokenHash = hashRefreshToken(token);
  const result = await db.execute(sql`
    SELECT
      EXISTS (
        SELECT 1 FROM refresh_tokens WHERE token = ${tokenHash}
      ) AS token_exists,
      COALESCE((
        SELECT is_active
        FROM refresh_tokens
        WHERE token = ${tokenHash}
        ORDER BY updated_at DESC
        LIMIT 1
      ), false) AS is_active,
      COALESCE((
        SELECT expires_at IS NULL OR expires_at > NOW()
        FROM refresh_tokens
        WHERE token = ${tokenHash}
        ORDER BY updated_at DESC
        LIMIT 1
      ), false) AS not_expired
  `);

  const [row] = getRefreshTokenStateRows(result);
  if (!row || !row.token_exists) {
    return 'missing';
  }

  if (row.is_active && row.not_expired) {
    return 'active';
  }

  return 'inactive';
};

export const listActiveRefreshSessions = async (
  db: QueryExecutor,
  userId: string
): Promise<RefreshSessionRow[]> => {
  await ensureRefreshTokensTable(db);
  const result = await db.execute(sql`
    SELECT
      id,
      user_id,
      created_at::text,
      updated_at::text,
      last_used_at::text,
      expires_at::text,
      user_agent,
      ip_address,
      token AS token_hash
    FROM refresh_tokens
    WHERE user_id = ${userId}::uuid
      AND is_active = true
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY COALESCE(last_used_at, updated_at, created_at) DESC
  `);

  return getRefreshSessionRows(result);
};

export const revokeRefreshSessionById = async (
  db: QueryExecutor,
  input: { userId: string; sessionId: string }
): Promise<boolean> => {
  await ensureRefreshTokensTable(db);
  const result = await db.execute(sql`
    UPDATE refresh_tokens
    SET is_active = false,
        updated_at = NOW(),
        revoked_at = NOW()
    WHERE id = ${input.sessionId}::uuid
      AND user_id = ${input.userId}::uuid
      AND is_active = true
    RETURNING id
  `);

  if (typeof result !== 'object' || result === null || !('rows' in result)) {
    return false;
  }

  const rows = (result as { rows: Array<{ id: string }> }).rows;
  return rows.length > 0;
};

type InvalidateRefreshTokenInput = {
  refreshToken?: string;
  userId?: string;
};

export const invalidateRefreshTokenIfSupported = async (
  db: QueryExecutor,
  input: InvalidateRefreshTokenInput
): Promise<void> => {
  await ensureRefreshTokensTable(db);

  const columnsResult = await db.execute(sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'refresh_tokens'
  `);
  const columns = new Set(getColumnRows(columnsResult).map((row) => row.column_name));
  if (!columns.has('is_active')) {
    return;
  }

  const hasUpdatedAt = columns.has('updated_at');
  const hasRevokedAt = columns.has('revoked_at');

  const setClauses = ['is_active = false'];
  if (hasUpdatedAt) {
    setClauses.push('updated_at = NOW()');
  }
  if (hasRevokedAt) {
    setClauses.push('revoked_at = NOW()');
  }

  const setSql = sql.raw(setClauses.join(', '));
  const refreshTokenHash = input.refreshToken ? hashRefreshToken(input.refreshToken) : undefined;

  if (columns.has('token') && refreshTokenHash) {
    await db.execute(sql`
      UPDATE refresh_tokens
      SET ${setSql}
      WHERE token = ${refreshTokenHash}
    `);
    return;
  }

  if (columns.has('refresh_token') && input.refreshToken) {
    await db.execute(sql`
      UPDATE refresh_tokens
      SET ${setSql}
      WHERE refresh_token = ${input.refreshToken}
    `);
    return;
  }

  if (columns.has('user_id') && input.userId) {
    await db.execute(sql`
      UPDATE refresh_tokens
      SET ${setSql}
      WHERE user_id = ${input.userId}
    `);
  }
};
