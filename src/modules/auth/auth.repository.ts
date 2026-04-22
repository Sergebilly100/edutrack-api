import { sql } from 'drizzle-orm';

export type QueryExecutor = {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
};

type AuthUserRow = {
  user_id: string;
  role: 'director' | 'staff' | 'secretary' | 'teacher' | 'super_admin';
  name: string;
  phone: string | null;
  email: string | null;
  profile_photo_url: string | null;
  password_hash: string;
  is_active: boolean;
  teacher_id: string | null;
  username: string | null;
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

type RegclassRow = {
  table_name: string | null;
};

const getColumnRows = (result: unknown): ColumnRow[] => {
  if (typeof result !== 'object' || result === null || !('rows' in result)) {
    return [];
  }

  const rows = (result as { rows: ColumnRow[] }).rows;
  return Array.isArray(rows) ? rows : [];
};

const getRegclassRows = (result: unknown): RegclassRow[] => {
  if (typeof result !== 'object' || result === null || !('rows' in result)) {
    return [];
  }

  const rows = (result as { rows: RegclassRow[] }).rows;
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
    ADD COLUMN IF NOT EXISTS profile_photo_url text
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

type InvalidateRefreshTokenInput = {
  refreshToken?: string;
  userId?: string;
};

export const invalidateRefreshTokenIfSupported = async (
  db: QueryExecutor,
  input: InvalidateRefreshTokenInput
): Promise<void> => {
  const tableExistsResult = await db.execute(sql`
    SELECT to_regclass('refresh_tokens')::text AS table_name
  `);

  const tableRows = getRegclassRows(tableExistsResult);
  const refreshTokensTableExists = tableRows.length > 0 && tableRows[0]?.table_name !== null;
  if (!refreshTokensTableExists) {
    return;
  }

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

  if (columns.has('token') && input.refreshToken) {
    await db.execute(sql`
      UPDATE refresh_tokens
      SET ${setSql}
      WHERE token = ${input.refreshToken}
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
