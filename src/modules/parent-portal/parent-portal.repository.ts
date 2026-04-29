import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { todayInBusinessTimezone } from '../../shared/utils/business-time.js';

export type TenantDb = NodePgDatabase<Record<string, unknown>>;

type ParentAuthRow = {
  id: string;
  phone: string;
  password_hash: string;
  must_change_password: boolean;
  is_active: boolean;
};

type ParentByIdRow = {
  id: string;
  password_hash: string;
  is_active: boolean;
};

type StudentSummaryRow = {
  id: string;
  first_name: string;
  last_name: string;
  class_name: string;
};

type ActiveSubscriptionRow = {
  id: string;
  status: 'active' | 'expired' | 'cancelled';
  starts_at: string;
  ends_at: string;
  student_count: number;
  total_amount_fcfa: number;
  duration_months: number;
  auto_renew_alert: boolean;
};

type ScheduleRow = {
  schedule_id: string;
  day_of_week: number;
  subject: string;
  room_name: string;
  teacher_name: string;
  start_time: string;
  end_time: string;
  slot_label: string;
};

type StudentAttendanceRow = {
  schedule_id: string;
  date: string;
  status: 'present' | 'absent' | 'excused';
};

type AbsenceRow = {
  date: string;
  time_label: string;
  subject: string;
  teacher_name: string;
  room_name: string;
};

export class ParentPortalRepository {
  constructor(private readonly db: TenantDb) {}

  async findParentByPhone(phone: string): Promise<ParentAuthRow | null> {
    try {
      const result = await this.db.execute<ParentAuthRow>(sql`
        SELECT id::text, phone, password_hash, must_change_password, is_active
        FROM parents
        WHERE phone = ${phone}
        LIMIT 1
      `);
      return result.rows[0] ?? null;
    } catch {
      const fallback = await this.db.execute<ParentAuthRow>(sql`
        SELECT id::text, phone, password_hash, false AS must_change_password, is_active
        FROM parents
        WHERE phone = ${phone}
        LIMIT 1
      `);
      return fallback.rows[0] ?? null;
    }
  }

  async findParentById(parentId: string): Promise<ParentByIdRow | null> {
    const result = await this.db.execute<ParentByIdRow>(sql`
      SELECT id::text, password_hash, is_active
      FROM parents
      WHERE id = ${parentId}::uuid
      LIMIT 1
    `);

    return result.rows[0] ?? null;
  }

  async updateParentLastLogin(parentId: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE parents
      SET last_login_at = NOW()
      WHERE id = ${parentId}::uuid
    `);
  }

  async updateParentPassword(parentId: string, passwordHash: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE parents
      SET password_hash = ${passwordHash},
          must_change_password = false
      WHERE id = ${parentId}::uuid
    `);
  }

  async listActiveStudentIds(parentId: string): Promise<string[]> {
    const businessToday = todayInBusinessTimezone();
    const result = await this.db.execute<{ student_id: string }>(sql`
      SELECT DISTINCT psl.student_id::text AS student_id
      FROM parent_student_links psl
      INNER JOIN parent_subscriptions ps ON ps.id = psl.subscription_id
      WHERE psl.parent_id = ${parentId}::uuid
        AND ps.status = 'active'
        AND ps.ends_at >= ${businessToday}::date
    `);

    return result.rows.map((row) => row.student_id);
  }

  async listStudentsByParent(parentId: string): Promise<StudentSummaryRow[]> {
    const businessToday = todayInBusinessTimezone();
    const result = await this.db.execute<StudentSummaryRow>(sql`
      SELECT
        DISTINCT s.id::text AS id,
        s.first_name,
        s.last_name,
        c.name AS class_name
      FROM parent_student_links psl
      INNER JOIN parent_subscriptions ps ON ps.id = psl.subscription_id
      INNER JOIN students s ON s.id = psl.student_id
      INNER JOIN classes c ON c.id = s.class_id
      WHERE psl.parent_id = ${parentId}::uuid
        AND ps.status = 'active'
        AND ps.ends_at >= ${businessToday}::date
      ORDER BY s.last_name ASC, s.first_name ASC
    `);

    return result.rows;
  }

  async getStudentClassId(studentId: string): Promise<string | null> {
    const result = await this.db.execute<{ class_id: string }>(sql`
      SELECT class_id::text AS class_id
      FROM students
      WHERE id = ${studentId}::uuid
      LIMIT 1
    `);

    return result.rows[0]?.class_id ?? null;
  }

  async listWeekSchedulesForClass(input: {
    classId: string;
    weekStart: string;
    weekEnd: string;
  }): Promise<ScheduleRow[]> {
    const result = await this.db.execute<ScheduleRow>(sql`
      SELECT
        s.id::text AS schedule_id,
        s.day_of_week,
        s.subject,
        r.name AS room_name,
        u.name AS teacher_name,
        ts.start_time::text AS start_time,
        ts.end_time::text AS end_time,
        ts.label AS slot_label
      FROM schedules s
      INNER JOIN schedule_periods sp ON sp.id = s.schedule_period_id
      INNER JOIN teachers t ON t.id = s.teacher_id
      INNER JOIN users u ON u.id = t.user_id
      INNER JOIN rooms r ON r.id = s.room_id
      INNER JOIN time_slots ts ON ts.id = s.time_slot_id
      WHERE s.class_id = ${input.classId}::uuid
        AND s.is_active = true
        AND sp.is_active = true
        AND sp.valid_from <= ${input.weekEnd}::date
        AND sp.valid_to >= ${input.weekStart}::date
      ORDER BY s.day_of_week ASC, ts.sort_order ASC, ts.start_time ASC
    `);

    return result.rows;
  }

  async listAttendancesForStudentInRange(input: {
    studentId: string;
    from: string;
    to: string;
  }): Promise<StudentAttendanceRow[]> {
    const result = await this.db.execute<StudentAttendanceRow>(sql`
      SELECT
        schedule_id::text AS schedule_id,
        date::text AS date,
        status::text AS status
      FROM attendances_student
      WHERE student_id = ${input.studentId}::uuid
        AND date BETWEEN ${input.from}::date AND ${input.to}::date
    `);

    return result.rows;
  }

  async listAbsencesByStudentAndMonth(input: {
    studentId: string;
    monthStart: string;
    monthEnd: string;
  }): Promise<AbsenceRow[]> {
    const result = await this.db.execute<AbsenceRow>(sql`
      SELECT
        a.date::text AS date,
        ts.label AS time_label,
        s.subject,
        u.name AS teacher_name,
        r.name AS room_name
      FROM attendances_student a
      INNER JOIN schedules s ON s.id = a.schedule_id
      INNER JOIN teachers t ON t.id = s.teacher_id
      INNER JOIN users u ON u.id = t.user_id
      INNER JOIN rooms r ON r.id = s.room_id
      INNER JOIN time_slots ts ON ts.id = s.time_slot_id
      WHERE a.student_id = ${input.studentId}::uuid
        AND a.status = 'absent'
        AND a.date BETWEEN ${input.monthStart}::date AND ${input.monthEnd}::date
      ORDER BY a.date DESC, ts.start_time DESC
    `);

    return result.rows;
  }

  async getActiveOrLatestSubscription(parentId: string): Promise<ActiveSubscriptionRow | null> {
    const businessToday = todayInBusinessTimezone();
    const result = await this.db.execute<ActiveSubscriptionRow>(sql`
      SELECT
        id::text,
        status::text AS status,
        starts_at::text,
        ends_at::text,
        student_count,
        total_amount_fcfa,
        duration_months,
        auto_renew_alert
      FROM parent_subscriptions
      WHERE parent_id = ${parentId}::uuid
      ORDER BY
        CASE WHEN status = 'active' AND ends_at >= ${businessToday}::date THEN 0 ELSE 1 END,
        ends_at DESC,
        created_at DESC
      LIMIT 1
    `);

    return result.rows[0] ?? null;
  }

  async countAbsencesForStudentInRange(input: {
    studentId: string;
    from: string;
    to: string;
  }): Promise<number> {
    const result = await this.db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM attendances_student
      WHERE student_id = ${input.studentId}::uuid
        AND status = 'absent'
        AND date BETWEEN ${input.from}::date AND ${input.to}::date
    `);

    return result.rows[0]?.count ?? 0;
  }

  async countAttendanceBreakdownForStudentMonth(input: {
    studentId: string;
    monthStart: string;
    monthEnd: string;
  }): Promise<{ present: number; absent: number; total: number }> {
    const result = await this.db.execute<{ present_count: number; absent_count: number; total_count: number }>(sql`
      SELECT
        COUNT(CASE WHEN status IN ('present', 'excused') THEN 1 END)::int AS present_count,
        COUNT(CASE WHEN status = 'absent' THEN 1 END)::int AS absent_count,
        COUNT(*)::int AS total_count
      FROM attendances_student
      WHERE student_id = ${input.studentId}::uuid
        AND date BETWEEN ${input.monthStart}::date AND ${input.monthEnd}::date
    `);

    return {
      present: result.rows[0]?.present_count ?? 0,
      absent: result.rows[0]?.absent_count ?? 0,
      total: result.rows[0]?.total_count ?? 0,
    };
  }
}
