import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgSchema,
  text,
  time,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const tenant = pgSchema('tenant');

export const userRoleEnum = tenant.enum('user_role', [
  'director',
  'secretary',
  'teacher',
  'super_admin',
]);

export const teacherTypeEnum = tenant.enum('teacher_type', ['vacataire', 'permanent']);

export const attendanceTeacherStatusEnum = tenant.enum('attendance_teacher_status', [
  'present',
  'absent',
  'late',
  'excused',
]);

export const attendanceStudentStatusEnum = tenant.enum('attendance_student_status', [
  'present',
  'absent',
  'excused',
]);

export const notificationTypeEnum = tenant.enum('notification_type', [
  'teacher_absent_director',
  'teacher_late_director',
  'teacher_qr_mismatch',
  'teacher_qr_missing_scan',
  'teacher_qr_scan_out_of_time',
  'student_absent_parent',
  'payment_reminder',
  'custom',
]);

export const notificationStatusEnum = tenant.enum('notification_status', [
  'queued',
  'sent',
  'failed',
  'delivered',
]);

export const importTypeEnum = tenant.enum('import_type', [
  'students',
  'teachers',
  'schedule',
]);

export const users = tenant.table('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  role: userRoleEnum('role').notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  phone: varchar('phone', { length: 20 }).unique(),
  email: varchar('email', { length: 255 }).unique(),
  passwordHash: text('password_hash').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

export const teachers = tenant.table(
  'teachers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    username: varchar('username', { length: 50 }).notNull().unique(),
    type: teacherTypeEnum('type').notNull(),
    subjects: text('subjects').array().notNull().default(sql`'{}'::text[]`),
    hourlyRate: integer('hourly_rate'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    teachersUsernameIdx: index('idx_teachers_username').on(table.username),
    teachersUserIdx: index('idx_teachers_user').on(table.userId),
  })
);

export const classes = tenant.table('classes', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  level: varchar('level', { length: 50 }),
  studentCount: integer('student_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

export const students = tenant.table(
  'students',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    classId: uuid('class_id')
      .notNull()
      .references(() => classes.id),
    firstName: varchar('first_name', { length: 100 }).notNull(),
    lastName: varchar('last_name', { length: 100 }).notNull(),
    parentPhone: varchar('parent_phone', { length: 20 }),
    parentPhone2: varchar('parent_phone_2', { length: 20 }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    studentsClassIdx: index('idx_students_class').on(table.classId),
  })
);

export const rooms = tenant.table(
  'rooms',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 100 }).notNull(),
    qrToken: varchar('qr_token', { length: 64 }).notNull().unique(),
    building: varchar('building', { length: 100 }),
    capacity: integer('capacity'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    roomsNameUnique: unique('rooms_name_unique').on(table.name),
    roomsQrTokenIdx: index('idx_rooms_qr_token').on(table.qrToken),
  })
);

export const timeSlots = tenant.table(
  'time_slots',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    label: varchar('label', { length: 50 }).notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (table) => ({
    validTimeRange: check(
      'time_slots_valid_time_range',
      sql`${table.startTime} < ${table.endTime}`
    ),
    timeSlotsLabelUnique: unique('time_slots_label_unique').on(table.label),
  })
);

export const schedulePeriods = tenant.table(
  'schedule_periods',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 150 }).notNull(),
    validFrom: date('valid_from', { mode: 'string' }).notNull(),
    validTo: date('valid_to', { mode: 'string' }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    validPeriodRange: check(
      'schedule_periods_valid_period_range',
      sql`${table.validFrom} <= ${table.validTo}`
    ),
    periodsDateIdx: index('idx_periods_dates').on(table.validFrom, table.validTo),
  })
);

export const schedules = tenant.table(
  'schedules',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    schedulePeriodId: uuid('schedule_period_id')
      .notNull()
      .references(() => schedulePeriods.id, { onDelete: 'cascade' }),
    teacherId: uuid('teacher_id')
      .notNull()
      .references(() => teachers.id),
    classId: uuid('class_id')
      .notNull()
      .references(() => classes.id),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id),
    timeSlotId: uuid('time_slot_id')
      .notNull()
      .references(() => timeSlots.id),
    dayOfWeek: integer('day_of_week').notNull(),
    subject: varchar('subject', { length: 100 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    dayOfWeekRange: check(
      'schedules_day_of_week_range',
      sql`${table.dayOfWeek} BETWEEN 1 AND 6`
    ),
    scheduleSlotTeacherUnique: unique('schedules_period_teacher_slot_day_unique').on(
      table.schedulePeriodId,
      table.teacherId,
      table.timeSlotId,
      table.dayOfWeek
    ),
    schedulesPeriodIdx: index('idx_schedules_period').on(table.schedulePeriodId),
    schedulesTeacherIdx: index('idx_schedules_teacher').on(table.teacherId),
    schedulesRoomIdx: index('idx_schedules_room').on(table.roomId),
    schedulesDayIdx: index('idx_schedules_day').on(table.dayOfWeek),
    schedulesActiveIdx: index('idx_schedules_active')
      .on(table.teacherId, table.dayOfWeek, table.timeSlotId)
      .where(sql`${table.isActive} = true`),
  })
);

export const attendancesTeacher = tenant.table(
  'attendances_teacher',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    teacherId: uuid('teacher_id')
      .notNull()
      .references(() => teachers.id),
    scheduleId: uuid('schedule_id').references(() => schedules.id),
    date: date('date', { mode: 'string' }).notNull(),
    status: attendanceTeacherStatusEnum('status').notNull().default('present'),
    checkedInAt: timestamp('checked_in_at', { withTimezone: true, mode: 'date' }),
    lateMinutes: integer('late_minutes'),
    roomScannedId: uuid('room_scanned_id').references(() => rooms.id),
    roomScanStartAt: timestamp('room_scan_start_at', {
      withTimezone: true,
      mode: 'date',
    }),
    roomScanEndAt: timestamp('room_scan_end_at', {
      withTimezone: true,
      mode: 'date',
    }),
    roomMismatch: boolean('room_mismatch').notNull().default(false),
    qrAlertSent: boolean('qr_alert_sent').notNull().default(false),
    markedBy: uuid('marked_by').references(() => users.id),
    syncedAt: timestamp('synced_at', { withTimezone: true, mode: 'date' }),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    attendanceTeacherUnique: unique('attendances_teacher_teacher_schedule_date_unique').on(
      table.teacherId,
      table.scheduleId,
      table.date
    ),
    lateMinutesPositive: check(
      'att_teacher_late_minutes_positive',
      sql`${table.lateMinutes} IS NULL OR ${table.lateMinutes} >= 0`
    ),
    scanTimeRange: check(
      'att_teacher_scan_time_range',
      sql`${table.roomScanEndAt} IS NULL OR ${table.roomScanStartAt} IS NULL OR ${
        table.roomScanEndAt
      } > ${table.roomScanStartAt}`
    ),
    attTeacherDateIdx: index('idx_att_teacher_date').on(table.teacherId, table.date),
    attTeacherScheduleIdx: index('idx_att_teacher_schedule').on(table.scheduleId, table.date),
    attTeacherMismatchIdx: index('idx_att_teacher_mismatch')
      .on(table.roomMismatch, table.date)
      .where(sql`${table.roomMismatch} = true`),
    attTeacherSyncedIdx: index('idx_att_teacher_synced')
      .on(table.syncedAt)
      .where(sql`${table.syncedAt} IS NULL`),
  })
);

export const attendancesStudent = tenant.table(
  'attendances_student',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id),
    scheduleId: uuid('schedule_id').references(() => schedules.id),
    date: date('date', { mode: 'string' }).notNull(),
    status: attendanceStudentStatusEnum('status').notNull().default('absent'),
    markedBy: uuid('marked_by').references(() => users.id),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    attendanceStudentUnique: unique('attendances_student_student_schedule_date_unique').on(
      table.studentId,
      table.scheduleId,
      table.date
    ),
    attStudentDateIdx: index('idx_att_student_date').on(table.studentId, table.date),
  })
);

export const notificationsLog = tenant.table(
  'notifications_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    type: notificationTypeEnum('type').notNull(),
    recipientPhone: varchar('recipient_phone', { length: 20 }).notNull(),
    message: text('message').notNull(),
    status: notificationStatusEnum('status').notNull().default('queued'),
    providerRef: varchar('provider_ref', { length: 255 }),
    relatedId: uuid('related_id'),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    notifStatusIdx: index('idx_notif_status')
      .on(table.status)
      .where(sql`${table.status} = 'queued'`),
  })
);

export const importHistory = tenant.table(
  'import_history',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    importType: importTypeEnum('import_type').notNull(),
    importedCount: integer('imported_count').notNull().default(0),
    updatedCount: integer('updated_count').notNull().default(0),
    importedAt: timestamp('imported_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    importHistoryTypeIdx: index('idx_import_history_type').on(table.importType),
    importHistoryImportedAtIdx: index('idx_import_history_imported_at').on(table.importedAt),
  })
);
