import { sql } from 'drizzle-orm';

export type QueryExecutor = {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
};

type AuthUserRow = {
  user_id: string;
  role: 'director' | 'secretary' | 'teacher' | 'super_admin';
  name: string;
  phone: string | null;
  email: string | null;
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

const baseSelect = sql`
  SELECT
    u.id AS user_id,
    u.role,
    u.name,
    u.phone,
    u.email,
    u.password_hash,
    u.is_active,
    t.id AS teacher_id,
    t.username
  FROM users u
  LEFT JOIN teachers t ON t.user_id = u.id
`;

export const findUserByPhone = async (
  db: QueryExecutor,
  phone: string
): Promise<AuthUser | null> => {
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
  const result = await db.execute(sql`
    ${baseSelect}
    WHERE t.username = ${username}
    LIMIT 1
  `);

  const [row] = getRows(result);
  return row ? mapAuthUser(row) : null;
};

export const findUserProfileById = async (
  db: QueryExecutor,
  userId: string
): Promise<AuthUser | null> => {
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
