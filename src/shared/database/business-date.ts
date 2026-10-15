import { sql } from 'drizzle-orm';

/** The school's civil date, independent of the PostgreSQL session timezone. */
export const BUSINESS_DATE_SQL = sql`(now() AT TIME ZONE 'Africa/Abidjan')::date`;
