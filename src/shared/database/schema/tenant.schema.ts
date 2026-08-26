import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { PermissionKey } from '../../types/index.js';

export const tenant = pgSchema('tenant');

export const userRoleEnum = tenant.enum('user_role', [
  'director',
  'staff',
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

export const attendanceValidationStatusEnum = tenant.enum('attendance_validation_status', [
  'not_required',
  'pending',
  'approved',
  'rejected',
]);

export const notificationTypeEnum = tenant.enum('notification_type', [
  'teacher_absent_director',
  'teacher_late_director',
  'teacher_qr_mismatch',
  'teacher_qr_missing_scan',
  'teacher_qr_scan_out_of_time',
  'qr_invalid_alert',
  'student_absent_parent',
  'attendance_rejected',
  'attendance_approved',
  'scan_end_warning',
  'scan_end_sanction',
  'scan_end_sanction_cancelled',
  'subscription_expiry_alert',
  'subscription_revenue_payout',
  'parent_access_credentials',
  'enrollment_documents_missing',
  'payment_reminder',
  'custom',
]);

export const notificationStatusEnum = tenant.enum('notification_status', [
  'queued',
  'sent',
  'failed',
  'delivered',
  'skipped_no_active_subscription',
  'skipped_feature_disabled',
  'skipped_cap_reached',
  'skipped_subscription_expired',
  'skipped_unknown',
]);

export const importTypeEnum = tenant.enum('import_type', [
  'students',
  'teachers',
  'schedule',
]);

export const documentEntityTypeEnum = tenant.enum('document_entity_type', [
  'teacher',
  'student',
]);

export const salaryStatusEnum = tenant.enum('salary_status', [
  'pending',
  'paid',
  'disputed',
  'nothing_to_pay',
]);

export const schoolYearStatusEnum = tenant.enum('school_year_status', [
  'draft',
  'active',
  'closed',
]);

export const gradingPeriodTypeEnum = tenant.enum('grading_period_type', [
  'trimester',
  'semester',
]);

export const evaluationTypeEnum = tenant.enum('evaluation_type', [
  'scheduled',
  'spontaneous',
]);

export const classSubjectCompletionStatusEnum = tenant.enum(
  'class_subject_completion_status',
  ['in_progress', 'completed']
);

export const classDecisionTypeEnum = tenant.enum('class_decision_type', [
  'promoted',
  'repeat',
  'expelled',
]);

export const reportCardStatusEnum = tenant.enum('report_card_status', [
  'generated',
  'published',
]);

export const reportCardLineTypeEnum = tenant.enum('report_card_line_type', [
  'subject',
  'conduct',
]);

export const studentLifecycleStatusEnum = tenant.enum('student_lifecycle_status', [
  'active',
  'expelled',
  'transferred',
]);

export const studentDocumentStatusEnum = tenant.enum('student_document_status', [
  'missing',
  'provided',
  'to_renew',
]);

export const enrollmentTypeEnum = tenant.enum('enrollment_type', [
  'new_registration',
  're_registration',
]);

export const enrollmentStatusEnum = tenant.enum('enrollment_status', [
  'pending_cashier',
  'pending_dossier',
  'confirmed',
  'blocked_unpaid',
]);

export const financePaymentMethodEnum = tenant.enum('finance_payment_method', [
  'mobile_money',
  'cash',
  'bank_transfer',
]);

export const paymentSourceEnum = tenant.enum('payment_source', [
  'in_app_button',
  'cashier_manual',
  'bulk_import',
  'migration_import',
]);

export const financePaymentStatusEnum = tenant.enum('finance_payment_status', [
  'confirmed',
  'waived_by_school',
  'cancelled',
]);

export const mobileMoneyProviderEnum = tenant.enum('mobile_money_provider', [
  'orange_money',
  'mtn_momo',
  'moov_money',
  'wave',
]);

export const subscriptionPeriodEnum = tenant.enum('subscription_period', [
  'monthly',
  'quarterly',
  'semester',
  'annual',
]);

export const users = tenant.table('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  role: userRoleEnum('role').notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  phone: varchar('phone', { length: 20 }).unique(),
  email: varchar('email', { length: 255 }).unique(),
  profilePhotoUrl: text('profile_photo_url'),
  passwordHash: text('password_hash').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  credentialsSentAt: timestamp('credentials_sent_at', { withTimezone: true, mode: 'date' }),
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
    matricule: varchar('matricule', { length: 50 }).unique(),
    type: teacherTypeEnum('type').notNull(),
    subjects: text('subjects').array().notNull().default(sql`'{}'::text[]`),
    hourlyRate: integer('hourly_rate'),
    monthlySalary: integer('monthly_salary'),
    isBlocked: boolean('is_blocked').notNull().default(false),
    blockedReason: text('blocked_reason'),
    blockedAt: timestamp('blocked_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedBy: uuid('updated_by').references(() => users.id),
  },
  (table) => ({
    teachersUsernameIdx: index('idx_teachers_username').on(table.username),
    teachersUserIdx: index('idx_teachers_user').on(table.userId),
    teachersUpdatedAtIdx: index('idx_teachers_updated_at').on(table.updatedAt),
  })
);

export const schoolYears = tenant.table(
  'school_years',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    label: varchar('label', { length: 25 }).notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    endOfYearReviewStartDate: date('end_of_year_review_start_date').notNull(),
    status: schoolYearStatusEnum('status').notNull().default('draft'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    schoolYearsLabelUnique: unique('school_years_label_unique').on(table.label),
    schoolYearsStatusIdx: index('idx_school_years_status').on(table.status),
    schoolYearsOneActiveIdx: uniqueIndex('school_years_one_active_idx')
      .on(table.status)
      .where(sql`${table.status} = 'active'`),
    schoolYearsValidDates: check(
      'school_years_valid_dates',
      sql`${table.startDate} < ${table.endDate}`
    ),
    schoolYearsReviewBeforeEnd: check(
      'school_years_review_before_end',
      sql`${table.endOfYearReviewStartDate} < ${table.endDate}`
    ),
  })
);

export const levels = tenant.table(
  'levels',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 100 }).notNull(),
    orderIndex: integer('order_index').notNull(),
    isExamClass: boolean('is_exam_class').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    levelsNameUnique: unique('levels_name_unique').on(table.name),
    levelsOrderIdx: index('idx_levels_order').on(table.orderIndex, table.name),
  })
);

export const classes = tenant.table(
  'classes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 100 }).notNull(),
    // Champ V1 conservé tant que les anciennes classes ne sont pas migrées.
    level: varchar('level', { length: 50 }),
    levelId: uuid('level_id').references(() => levels.id),
    schoolYearId: uuid('school_year_id').references(() => schoolYears.id),
    homeroomTeacherId: uuid('homeroom_teacher_id').references(() => teachers.id, {
      onDelete: 'set null',
    }),
    studentCount: integer('student_count').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    isAssigned: boolean('is_assigned'),
    lifecycleStatus: studentLifecycleStatusEnum('lifecycle_status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    classesSchoolYearIdx: index('idx_classes_school_year').on(table.schoolYearId),
    classesLevelIdx: index('idx_classes_level').on(table.levelId),
    classesHomeroomTeacherIdx: index('idx_classes_homeroom_teacher').on(
      table.homeroomTeacherId
    ),
    classesActiveYearNameUnique: uniqueIndex('classes_active_year_name_unique')
      .on(table.schoolYearId, table.name)
      .where(sql`${table.isActive} = true AND ${table.schoolYearId} IS NOT NULL`),
  })
);

export const students = tenant.table(
  'students',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    classId: uuid('class_id')
      .notNull()
      .references(() => classes.id),
    matricule: varchar('matricule', { length: 50 }).unique(),
    firstName: varchar('first_name', { length: 100 }).notNull(),
    lastName: varchar('last_name', { length: 100 }).notNull(),
    birthDate: date('birth_date'),
    parentName: varchar('parent_name', { length: 255 }),
    parentPhone: varchar('parent_phone', { length: 20 }),
    parentEmail: varchar('parent_email', { length: 255 }),
    parentName2: varchar('parent_name_2', { length: 255 }),
    parentPhone2: varchar('parent_phone_2', { length: 20 }),
    notes: text('notes'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    studentsClassIdx: index('idx_students_class').on(table.classId),
  })
);

export const classDecisions = tenant.table(
  'class_decisions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    studentId: uuid('student_id').notNull().references(() => students.id, { onDelete: 'cascade' }),
    schoolYearId: uuid('school_year_id').notNull().references(() => schoolYears.id, { onDelete: 'cascade' }),
    suggestedDecision: classDecisionTypeEnum('suggested_decision'),
    finalDecision: classDecisionTypeEnum('final_decision'),
    validatedByUserId: uuid('validated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    validatedAt: timestamp('validated_at', { withTimezone: true, mode: 'date' }),
    nextLevelId: uuid('next_level_id').references(() => levels.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    classDecisionsStudentYearUnique: unique('class_decisions_student_year_unique').on(
      table.studentId,
      table.schoolYearId
    ),
    classDecisionsSchoolYearIdx: index('idx_class_decisions_school_year').on(table.schoolYearId),
  })
);

export const requiredDocumentTypes = tenant.table(
  'required_document_types',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    levelId: uuid('level_id').notNull().references(() => levels.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 150 }).notNull(),
    isMandatory: boolean('is_mandatory').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    requiredDocumentTypesLevelNameUnique: unique('required_document_types_level_name_unique').on(
      table.levelId,
      table.name
    ),
    requiredDocumentTypesLevelIdx: index('idx_required_document_types_level').on(table.levelId),
  })
);

export const studentDocuments = tenant.table(
  'student_documents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    studentId: uuid('student_id').notNull().references(() => students.id, { onDelete: 'cascade' }),
    documentTypeId: uuid('document_type_id').notNull().references(() => requiredDocumentTypes.id, { onDelete: 'cascade' }),
    status: studentDocumentStatusEnum('status').notNull().default('missing'),
    fileUrl: text('file_url'),
    r2Key: varchar('r2_key', { length: 500 }),
    providedAt: timestamp('provided_at', { withTimezone: true, mode: 'date' }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    studentDocumentsStudentTypeUnique: unique('student_documents_student_type_unique').on(
      table.studentId,
      table.documentTypeId
    ),
    studentDocumentsStudentIdx: index('idx_student_documents_student').on(table.studentId),
  })
);

export const enrollments = tenant.table(
  'enrollments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    studentId: uuid('student_id').notNull().references(() => students.id, { onDelete: 'cascade' }),
    classId: uuid('class_id').notNull().references(() => classes.id),
    schoolYearId: uuid('school_year_id').notNull().references(() => schoolYears.id),
    type: enrollmentTypeEnum('type').notNull(),
    status: enrollmentStatusEnum('status').notNull(),
    enrolledAt: timestamp('enrolled_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    confirmedByUserId: uuid('confirmed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    enrollmentsStudentYearUnique: unique('enrollments_student_year_unique').on(
      table.studentId,
      table.schoolYearId
    ),
    enrollmentsYearStatusIdx: index('idx_enrollments_year_status').on(table.schoolYearId, table.status),
  })
);

export const tuitionPlans = tenant.table(
  'tuition_plans',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    levelId: uuid('level_id').notNull().references(() => levels.id, { onDelete: 'cascade' }),
    schoolYearId: uuid('school_year_id').notNull().references(() => schoolYears.id, { onDelete: 'cascade' }),
    totalAmount: numeric('total_amount', { precision: 12, scale: 2 }).notNull(),
    currency: varchar('currency', { length: 10 }).notNull().default('FCFA'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    tuitionPlansLevelYearUnique: unique('tuition_plans_level_year_unique').on(table.levelId, table.schoolYearId),
    tuitionPlansSchoolYearIdx: index('idx_tuition_plans_school_year').on(table.schoolYearId, table.levelId),
    tuitionPlansAmountNonNegative: check('tuition_plans_amount_non_negative', sql`${table.totalAmount} >= 0`),
  })
);

export const tuitionScheduleSteps = tenant.table(
  'tuition_schedule_steps',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tuitionPlanId: uuid('tuition_plan_id').notNull().references(() => tuitionPlans.id, { onDelete: 'cascade' }),
    dueDate: date('due_date', { mode: 'string' }).notNull(),
    cumulativeAmountExpected: numeric('cumulative_amount_expected', { precision: 12, scale: 2 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    tuitionScheduleStepsPlanDateUnique: unique('tuition_schedule_steps_plan_date_unique').on(table.tuitionPlanId, table.dueDate),
    tuitionScheduleStepsAmountNonNegative: check('tuition_schedule_steps_amount_non_negative', sql`${table.cumulativeAmountExpected} >= 0`),
    tuitionScheduleStepsDueDateIdx: index('idx_tuition_schedule_steps_due_date').on(table.tuitionPlanId, table.dueDate),
  })
);

export const studentTuitionOverrides = tenant.table(
  'student_tuition_overrides',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    studentId: uuid('student_id').notNull().references(() => students.id, { onDelete: 'cascade' }),
    schoolYearId: uuid('school_year_id').notNull().references(() => schoolYears.id, { onDelete: 'cascade' }),
    overrideTotalAmount: numeric('override_total_amount', { precision: 12, scale: 2 }),
    discountAmount: numeric('discount_amount', { precision: 12, scale: 2 }),
    reason: text('reason').notNull(),
    grantedByUserId: uuid('granted_by_user_id').notNull().references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    studentTuitionOverridesStudentYearUnique: unique('student_tuition_overrides_student_year_unique').on(table.studentId, table.schoolYearId),
    studentTuitionOverridesOneValue: check('student_tuition_overrides_one_value', sql`(${table.overrideTotalAmount} IS NOT NULL AND ${table.discountAmount} IS NULL) OR (${table.overrideTotalAmount} IS NULL AND ${table.discountAmount} IS NOT NULL)`),
  })
);

export const paymentProviderSettings = tenant.table(
  'payment_provider_settings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    provider: mobileMoneyProviderEnum('provider').notNull(),
    merchantNumber: varchar('merchant_number', { length: 100 }).notNull(),
    apiCredentials: jsonb('api_credentials').$type<Record<string, unknown>>().notNull(),
    isActive: boolean('is_active').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    paymentProviderSettingsProviderUnique: unique('payment_provider_settings_provider_unique').on(table.provider),
    paymentProviderSettingsActiveIdx: index('idx_payment_provider_settings_active').on(table.isActive),
  })
);

export const payments = tenant.table(
  'payments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    studentId: uuid('student_id').notNull().references(() => students.id),
    schoolYearId: uuid('school_year_id').notNull().references(() => schoolYears.id),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    method: financePaymentMethodEnum('method').notNull(),
    source: paymentSourceEnum('source').notNull(),
    status: financePaymentStatusEnum('status').notNull().default('confirmed'),
    confirmedByUserId: uuid('confirmed_by_user_id').references(() => users.id),
    providerReference: varchar('provider_reference', { length: 255 }),
    schoolReceiptReference: varchar('school_receipt_reference', { length: 255 }),
    receiptNumber: varchar('receipt_number', { length: 100 }).notNull(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    cancelledByUserId: uuid('cancelled_by_user_id').references(() => users.id),
    cancellationReason: text('cancellation_reason'),
    paymentDate: date('payment_date', { mode: 'string' }).notNull().default(sql`CURRENT_DATE`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    paymentsReceiptNumberUnique: unique('payments_receipt_number_unique').on(table.receiptNumber),
    paymentsAmountPositive: check('payments_amount_positive', sql`${table.amount} > 0`),
    paymentsStudentYearCreatedIdx: index('idx_payments_student_year_created').on(table.studentId, table.schoolYearId, table.createdAt),
    paymentsJournalFiltersIdx: index('idx_payments_journal_filters').on(table.paymentDate, table.method, table.studentId),
  })
);

export const importMappingProfiles = tenant.table(
  'import_mapping_profiles',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    importType: varchar('import_type', { length: 80 }).notNull(),
    label: varchar('label', { length: 255 }),
    createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    activeTypeUnique: uniqueIndex('import_mapping_profiles_one_active_type')
      .on(table.importType)
      .where(sql`${table.isActive} = true`),
    typeUpdatedIdx: index('idx_import_mapping_profiles_type_updated').on(table.importType, table.updatedAt),
  })
);

export const importMappingFields = tenant.table(
  'import_mapping_fields',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    profileId: uuid('profile_id').notNull().references(() => importMappingProfiles.id, { onDelete: 'cascade' }),
    sourceColumnLabel: varchar('source_column_label', { length: 255 }).notNull(),
    targetField: varchar('target_field', { length: 100 }).notNull(),
    isRequired: boolean('is_required').notNull().default(false),
  },
  (table) => ({
    profileTargetUnique: unique('import_mapping_fields_profile_target_unique_constraint').on(table.profileId, table.targetField),
  })
);

export const importMappingValueTranslations = tenant.table(
  'import_mapping_value_translations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    mappingFieldId: uuid('mapping_field_id').notNull().references(() => importMappingFields.id, { onDelete: 'cascade' }),
    sourceValue: varchar('source_value', { length: 255 }).notNull(),
    targetValue: varchar('target_value', { length: 255 }).notNull(),
  }
);

export const subscriptionPlans = tenant.table(
  'subscription_plans',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    period: subscriptionPeriodEnum('period').notNull(),
    label: varchar('label', { length: 255 }).notNull(),
    isMandatoryAtEnrollment: boolean('is_mandatory_at_enrollment').notNull().default(false),
    imposedDuration: subscriptionPeriodEnum('imposed_duration'),
    showOnReceiptAsSeparateLine: boolean('show_on_receipt_as_separate_line').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    subscriptionPlansAmountNonNegative: check('subscription_plans_amount_non_negative', sql`${table.amount} >= 0`),
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
    latitude: numeric('latitude', { precision: 10, scale: 7 }),
    longitude: numeric('longitude', { precision: 10, scale: 7 }),
    geoRadius: integer('geo_radius').default(100),
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
    startDate: date('start_date', { mode: 'string' }),
    endDate: date('end_date', { mode: 'string' }),
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
    scheduleSlotTeacherActiveUnique: uniqueIndex('schedules_period_teacher_slot_day_active_unique')
      .on(table.schedulePeriodId, table.teacherId, table.timeSlotId, table.dayOfWeek)
      .where(sql`${table.isActive} = true AND ${table.endDate} IS NULL`),
    schedulesPeriodIdx: index('idx_schedules_period').on(table.schedulePeriodId),
    schedulesTeacherIdx: index('idx_schedules_teacher').on(table.teacherId),
    schedulesRoomIdx: index('idx_schedules_room').on(table.roomId),
    schedulesDayIdx: index('idx_schedules_day').on(table.dayOfWeek),
    schedulesActiveIdx: index('idx_schedules_active')
      .on(table.teacherId, table.dayOfWeek, table.timeSlotId)
      .where(sql`${table.isActive} = true`),
    schedulesClassDayIdx: index('idx_schedules_class_day')
      .on(table.classId, table.dayOfWeek)
      .where(sql`${table.isActive} = true`),
  })
);

export const subjects = tenant.table(
  'subjects',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    levelId: uuid('level_id').notNull().references(() => levels.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    coefficient: numeric('coefficient', { precision: 8, scale: 3 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    subjectsLevelNameUnique: unique('subjects_level_name_unique').on(table.levelId, table.name),
    subjectsLevelIdx: index('idx_subjects_level').on(table.levelId, table.name),
    subjectsCoefficientPositive: check('subjects_coefficient_positive', sql`${table.coefficient} > 0`),
  })
);

export const teacherSubjectAssignments = tenant.table(
  'teacher_subject_assignments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    teacherId: uuid('teacher_id').notNull().references(() => teachers.id, { onDelete: 'cascade' }),
    subjectId: uuid('subject_id').notNull().references(() => subjects.id, { onDelete: 'cascade' }),
    classId: uuid('class_id').notNull().references(() => classes.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    teacherSubjectAssignmentsUnique: unique('teacher_subject_assignments_unique').on(
      table.teacherId,
      table.subjectId,
      table.classId
    ),
    teacherSubjectAssignmentsTeacherIdx: index('idx_teacher_subject_assignments_teacher').on(table.teacherId),
    teacherSubjectAssignmentsClassIdx: index('idx_teacher_subject_assignments_class').on(table.classId, table.subjectId),
  })
);

export const gradingPeriods = tenant.table(
  'grading_periods',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    schoolYearId: uuid('school_year_id').notNull().references(() => schoolYears.id, { onDelete: 'cascade' }),
    type: gradingPeriodTypeEnum('type').notNull(),
    orderIndex: integer('order_index').notNull(),
    label: varchar('label', { length: 100 }).notNull(),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    gradingPeriodsYearOrderUnique: unique('grading_periods_year_order_unique').on(table.schoolYearId, table.orderIndex),
    gradingPeriodsYearLabelUnique: unique('grading_periods_year_label_unique').on(table.schoolYearId, table.label),
    gradingPeriodsYearIdx: index('idx_grading_periods_year').on(table.schoolYearId, table.orderIndex),
    gradingPeriodsValidDates: check('grading_periods_valid_dates', sql`${table.startDate} <= ${table.endDate}`),
    gradingPeriodsOrderPositive: check('grading_periods_order_positive', sql`${table.orderIndex} > 0`),
  })
);

export const evaluations = tenant.table(
  'evaluations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    lessonSlotId: uuid('lesson_slot_id').notNull().references(() => schedules.id),
    subjectId: uuid('subject_id').notNull().references(() => subjects.id),
    classId: uuid('class_id').notNull().references(() => classes.id),
    gradingPeriodId: uuid('grading_period_id').notNull().references(() => gradingPeriods.id),
    teacherId: uuid('teacher_id').notNull().references(() => teachers.id),
    type: evaluationTypeEnum('type').notNull(),
    coefficient: numeric('coefficient', { precision: 8, scale: 3 }).notNull(),
    label: varchar('label', { length: 150 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    evaluationsPeriodSubjectClassIdx: index('idx_evaluations_period_subject_class').on(table.gradingPeriodId, table.subjectId, table.classId),
    evaluationsTeacherIdx: index('idx_evaluations_teacher').on(table.teacherId),
    evaluationsCoefficientPositive: check('evaluations_coefficient_positive', sql`${table.coefficient} > 0`),
  })
);

export const evaluationGrades = tenant.table(
  'evaluation_grades',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    evaluationId: uuid('evaluation_id').notNull().references(() => evaluations.id, { onDelete: 'cascade' }),
    studentId: uuid('student_id').notNull().references(() => students.id, { onDelete: 'cascade' }),
    score: numeric('score', { precision: 8, scale: 3 }).notNull(),
    maxScore: numeric('max_score', { precision: 8, scale: 3 }).notNull(),
    comment: text('comment'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    evaluationGradesEvaluationStudentUnique: unique('evaluation_grades_evaluation_student_unique').on(table.evaluationId, table.studentId),
    evaluationGradesStudentIdx: index('idx_evaluation_grades_student').on(table.studentId),
    evaluationGradesScoreNonNegative: check('evaluation_grades_score_non_negative', sql`${table.score} >= 0`),
    evaluationGradesMaxScorePositive: check('evaluation_grades_max_score_positive', sql`${table.maxScore} > 0`),
    evaluationGradesScoreWithinMax: check('evaluation_grades_score_within_max', sql`${table.score} <= ${table.maxScore}`),
  })
);

export const educatorAssignments = tenant.table(
  'educator_assignments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    classId: uuid('class_id').references(() => classes.id, { onDelete: 'cascade' }),
    levelId: uuid('level_id').references(() => levels.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    assignedBy: uuid('assigned_by').references(() => users.id),
    assignedAt: timestamp('assigned_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    educatorAssignmentClassUnique: uniqueIndex('educator_assignments_class_unique')
      .on(table.classId)
      .where(sql`class_id IS NOT NULL`),
    educatorAssignmentLevelUnique: uniqueIndex('educator_assignments_level_unique')
      .on(table.levelId)
      .where(sql`level_id IS NOT NULL`),
    educatorAssignmentUserIdx: index('idx_educator_assignments_user').on(table.userId),
    educatorAssignmentTargetRequired: check(
      'educator_assignments_target_required',
      sql`(class_id IS NOT NULL)::int + (level_id IS NOT NULL)::int = 1`
    ),
  })
);

export const teacherConductInputs = tenant.table(
  'teacher_conduct_inputs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    teacherId: uuid('teacher_id')
      .notNull()
      .references(() => teachers.id, { onDelete: 'cascade' }),
    classId: uuid('class_id')
      .notNull()
      .references(() => classes.id),
    gradingPeriodId: uuid('grading_period_id')
      .notNull()
      .references(() => gradingPeriods.id, { onDelete: 'cascade' }),
    note: numeric('note', { precision: 5, scale: 2 }).notNull(),
    observation: text('observation'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    teacherConductInputOncePerPeriod: unique(
      'teacher_conduct_inputs_once_per_period'
    ).on(table.studentId, table.teacherId, table.gradingPeriodId),
    teacherConductInputsStudentIdx: index('idx_teacher_conduct_inputs_student').on(table.studentId),
    teacherConductInputsNoteRange: check(
      'teacher_conduct_inputs_note_range',
      sql`${table.note} >= 0 AND ${table.note} <= 20`
    ),
  })
);

export const conductGrades = tenant.table(
  'conduct_grades',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    gradingPeriodId: uuid('grading_period_id')
      .notNull()
      .references(() => gradingPeriods.id, { onDelete: 'cascade' }),
    note: numeric('note', { precision: 5, scale: 2 }).notNull(),
    coefficient: numeric('coefficient', { precision: 8, scale: 3 }).notNull().default(sql`'1'`),
    decidedByUserId: uuid('decided_by_user_id')
      .notNull()
      .references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    conductGradesStudentPeriodUnique: unique('conduct_grades_student_period_unique').on(
      table.studentId,
      table.gradingPeriodId
    ),
    conductGradesStudentIdx: index('idx_conduct_grades_student').on(table.studentId),
    conductGradesNoteRange: check('conduct_grades_note_range', sql`${table.note} >= 0 AND ${table.note} <= 20`),
    conductGradesCoefficientPositive: check('conduct_grades_coefficient_positive', sql`${table.coefficient} > 0`),
  })
);

export const classSubjectCompletion = tenant.table(
  'class_subject_completion',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    classId: uuid('class_id').notNull().references(() => classes.id, { onDelete: 'cascade' }),
    subjectId: uuid('subject_id').notNull().references(() => subjects.id, { onDelete: 'cascade' }),
    gradingPeriodId: uuid('grading_period_id').notNull().references(() => gradingPeriods.id, { onDelete: 'cascade' }),
    status: classSubjectCompletionStatusEnum('status').notNull().default('in_progress'),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    classSubjectCompletionUnique: unique('class_subject_completion_unique').on(table.classId, table.subjectId, table.gradingPeriodId),
    classSubjectCompletionPeriodClassIdx: index('idx_class_subject_completion_period_class').on(table.gradingPeriodId, table.classId),
  })
);

export const studentPeriodAverages = tenant.table(
  'student_period_averages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    studentId: uuid('student_id').notNull().references(() => students.id, { onDelete: 'cascade' }),
    subjectId: uuid('subject_id').references(() => subjects.id, { onDelete: 'cascade' }),
    gradingPeriodId: uuid('grading_period_id').notNull().references(() => gradingPeriods.id, { onDelete: 'cascade' }),
    average: numeric('average', { precision: 8, scale: 3 }).notNull(),
    rank: integer('rank'),
    computedAt: timestamp('computed_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    studentPeriodAveragesSubjectUnique: uniqueIndex('student_period_averages_subject_unique')
      .on(table.studentId, table.subjectId, table.gradingPeriodId)
      .where(sql`${table.subjectId} IS NOT NULL`),
    studentPeriodAveragesGeneralUnique: uniqueIndex('student_period_averages_general_unique')
      .on(table.studentId, table.gradingPeriodId)
      .where(sql`${table.subjectId} IS NULL`),
    studentPeriodAveragesPeriodIdx: index('idx_student_period_averages_period').on(table.gradingPeriodId, table.subjectId),
    studentPeriodAveragesRankPositive: check('student_period_averages_rank_positive', sql`${table.rank} IS NULL OR ${table.rank} > 0`),
  })
);

export const scheduleExceptions = tenant.table(
  'schedule_exceptions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => schedules.id, { onDelete: 'cascade' }),
    exceptionDate: date('exception_date', { mode: 'string' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    scheduleExceptionUnique: uniqueIndex('schedule_exceptions_schedule_date_unique')
      .on(table.scheduleId, table.exceptionDate),
    scheduleExceptionScheduleIdx: index('idx_schedule_exceptions_schedule').on(table.scheduleId),
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
    checkedOutAt: timestamp('checked_out_at', { withTimezone: true, mode: 'date' }),
    actualMinutes: integer('actual_minutes'),
    lateMinutes: integer('late_minutes'),
    checkinLatitude: numeric('checkin_latitude', { precision: 10, scale: 7 }),
    checkinLongitude: numeric('checkin_longitude', { precision: 10, scale: 7 }),
    checkinAccuracy: numeric('checkin_accuracy', { precision: 6, scale: 2 }),
    checkinDistance: numeric('checkin_distance', { precision: 8, scale: 2 }),
    geoStatus: text('geo_status').default('not_checked'),
    roomScannedId: uuid('room_scanned_id').references(() => rooms.id),
    roomScanStartAt: timestamp('room_scan_start_at', {
      withTimezone: true,
      mode: 'date',
    }),
    checkoutLatitude: numeric('checkout_latitude', { precision: 10, scale: 7 }),
    checkoutLongitude: numeric('checkout_longitude', { precision: 10, scale: 7 }),
    checkoutAccuracy: numeric('checkout_accuracy', { precision: 6, scale: 2 }),
    checkoutGeoStatus: text('checkout_geo_status').default('not_checked'),
    roomScanEndAt: timestamp('room_scan_end_at', {
      withTimezone: true,
      mode: 'date',
    }),
    roomMismatch: boolean('room_mismatch').notNull().default(false),
    qrAlertSent: boolean('qr_alert_sent').notNull().default(false),
    validationStatus: attendanceValidationStatusEnum('validation_status')
      .notNull()
      .default('not_required'),
    validationReason: text('validation_reason'),
    validatedBy: uuid('validated_by').references(() => users.id),
    validatedAt: timestamp('validated_at', { withTimezone: true, mode: 'date' }),
    validatedHours: numeric('validated_hours', { precision: 5, scale: 2 }),
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
    actualMinutesRange: check(
      'att_teacher_actual_minutes_range',
      sql`${table.actualMinutes} IS NULL OR (${table.actualMinutes} >= 0 AND ${table.actualMinutes} <= 1440)`
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
    attTeacherDateStatusAbsentIdx: index('idx_att_teacher_date_status_absent')
      .on(table.date)
      .where(sql`status = 'absent'`),
    attTeacherValidationPendingIdx: index('idx_att_teacher_validation_pending')
      .on(table.validationStatus, table.date)
      .where(sql`validation_status = 'pending'`),
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
    excuseReason: text('excuse_reason'),
    excusedBy: uuid('excused_by').references(() => users.id),
    excusedAt: timestamp('excused_at', { withTimezone: true, mode: 'date' }),
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
    attStudentExcusedIdx: index('idx_att_student_excused')
      .on(table.studentId, table.date)
      .where(sql`status = 'excused'`),
    attStudentScheduleDateIdx: index('idx_att_student_schedule_date').on(
      table.scheduleId,
      table.date
    ),
  })
);

export const notificationsLog = tenant.table(
  'notifications_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    type: notificationTypeEnum('type').notNull(),
    channel: varchar('channel', { length: 10 }).notNull().default('sms'),
    recipientId: uuid('recipient_id'),
    recipientPhone: varchar('recipient_phone', { length: 20 }).notNull(),
    recipientEmail: varchar('recipient_email', { length: 255 }),
    message: text('message').notNull(),
    metadata: jsonb('metadata'),
    status: notificationStatusEnum('status').notNull().default('queued'),
    providerRef: varchar('provider_ref', { length: 255 }),
    relatedId: uuid('related_id'),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    notificationsChannelCheck: check(
      'notifications_log_channel_check',
      sql`${table.channel} IN ('sms', 'email', 'in_app')`
    ),
    notifStatusIdx: index('idx_notif_status')
      .on(table.status)
      .where(sql`${table.status} = 'queued'`),
    notifTypeRelatedIdx: index('idx_notifications_log_type_related').on(
      table.type,
      table.relatedId,
      table.recipientPhone,
      table.createdAt.desc()
    ),
    notifPhoneCreatedIdx: index('idx_notifications_log_phone_created').on(
      table.recipientPhone,
      table.type,
      table.createdAt.desc()
    ),
    notifProviderRefIdx: index('idx_notifications_log_provider_ref')
      .on(table.providerRef)
      .where(sql`${table.providerRef} IS NOT NULL`),
  })
);

export const importHistory = tenant.table(
  'import_history',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    importType: importTypeEnum('import_type').notNull(),
    importedCount: integer('imported_count').notNull().default(0),
    updatedCount: integer('updated_count').notNull().default(0),
    schedule_period: varchar('schedule_period', { length: 255 }),
    importedBy: uuid('imported_by').references(() => users.id),
    importedByRole: varchar('imported_by_role', { length: 100 }),
    importedAt: timestamp('imported_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    importHistoryTypeIdx: index('idx_import_history_type').on(table.importType),
    importHistoryImportedAtIdx: index('idx_import_history_imported_at').on(table.importedAt),
  })
);

export const documents = tenant.table(
  'documents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    entityType: documentEntityTypeEnum('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    type: varchar('type', { length: 50 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    r2Key: varchar('r2_key', { length: 500 }).notNull(),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    documentsEntityIdx: index('idx_documents_entity').on(table.entityType, table.entityId),
  })
);

export const adminPositions = tenant.table(
  'admin_positions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 100 }).notNull(),
    permissions: jsonb('permissions').$type<PermissionKey[]>().notNull().default(sql`'[]'::jsonb`),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    positionsCreatedByIdx: index('idx_positions_created_by').on(table.createdBy),
  })
);

export const positionAssignments = tenant.table(
  'position_assignments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    positionId: uuid('position_id')
      .notNull()
      .references(() => adminPositions.id, { onDelete: 'cascade' }),
    assignedBy: uuid('assigned_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    positionAssignmentUnique: unique('position_assignments_user_position_unique').on(
      table.userId,
      table.positionId
    ),
  })
);

export const salaryRecords = tenant.table(
  'salary_records',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    teacherId: uuid('teacher_id')
      .notNull()
      .references(() => teachers.id),
    periodMonth: date('period_month', { mode: 'string' }).notNull(),
    hoursPlanned: numeric('hours_planned', { precision: 6, scale: 2 }).notNull(),
    hoursDone: numeric('hours_done', { precision: 6, scale: 2 }).notNull(),
    hourlyRate: integer('hourly_rate').notNull(),
    totalFcfa: integer('total_fcfa').notNull(),
    status: salaryStatusEnum('status').notNull().default('pending'),
    paidAt: timestamp('paid_at', { withTimezone: true, mode: 'date' }),
    paidBy: uuid('paid_by').references(() => users.id),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    salaryTeacherMonthUnique: unique('salary_records_teacher_period_month_unique').on(
      table.teacherId,
      table.periodMonth
    ),
    salaryTeacherMonthIdx: index('idx_salary_teacher_month').on(table.teacherId, table.periodMonth),
    salaryRecordsPeriodIdx: index('idx_salary_records_period').on(
      table.periodMonth,
      table.status
    ),
  })
);

export const salaryPayments = tenant.table(
  'salary_payments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    salaryRecordId: uuid('salary_record_id')
      .notNull()
      .references(() => salaryRecords.id, { onDelete: 'cascade' }),
    hoursPaid: numeric('hours_paid', { precision: 6, scale: 2 }),
    amountFcfa: integer('amount_fcfa').notNull(),
    notes: text('notes'),
    paidAt: timestamp('paid_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    paidBy: uuid('paid_by')
      .notNull()
      .references(() => users.id),
  },
  (table) => ({
    salaryPaymentsRecordPaidAtIdx: index('idx_salary_payments_record_paid_at').on(
      table.salaryRecordId,
      table.paidAt
    ),
  })
);

export const parents = tenant.table(
  'parents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    fullName: varchar('full_name', { length: 255 }).notNull(),
    phone: varchar('phone', { length: 20 }).notNull().unique(),
    email: varchar('email', { length: 255 }),
    passwordHash: text('password_hash').notNull(),
    mustChangePassword: boolean('must_change_password').notNull().default(true),
    accessSentAt: timestamp('access_sent_at', { withTimezone: true, mode: 'date' }),
    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    parentsPhoneIdx: index('idx_parents_phone').on(table.phone),
    parentsAccessPendingIdx: index('idx_parents_access_pending')
      .on(table.createdAt)
      .where(sql`${table.accessSentAt} IS NULL`),
  })
);

export const parentSubscriptions = tenant.table(
  'parent_subscriptions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    parentId: uuid('parent_id')
      .notNull()
      .references(() => parents.id, { onDelete: 'cascade' }),
    unitPriceFcfa: integer('unit_price_fcfa').notNull(),
    studentCount: integer('student_count').notNull(),
    totalAmountFcfa: integer('total_amount_fcfa').notNull(),
    durationMonths: integer('duration_months').notNull().default(1),
    startsAt: date('starts_at', { mode: 'string' }).notNull(),
    endsAt: date('ends_at', { mode: 'string' }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('active'),
    autoRenewAlert: boolean('auto_renew_alert').notNull().default(false),
    renewedCount: integer('renewed_count').notNull().default(0),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    parentSubscriptionsStatusCheck: check(
      'parent_subscriptions_status_check',
      sql`${table.status} IN ('active', 'expired', 'cancelled')`
    ),
    parentSubscriptionsUnitPriceNonNegativeCheck: check(
      'parent_subscriptions_unit_price_non_negative_check',
      sql`${table.unitPriceFcfa} >= 0`
    ),
    parentSubscriptionsTotalAmountNonNegativeCheck: check(
      'parent_subscriptions_total_amount_non_negative_check',
      sql`${table.totalAmountFcfa} >= 0`
    ),
    parentSubscriptionsParentIdx: index('idx_parent_subs_parent').on(table.parentId),
    parentSubscriptionsStatusEndIdx: index('idx_parent_subs_status_end').on(
      table.status,
      table.endsAt
    ),
  })
);

export const parentStudentLinks = tenant.table(
  'parent_student_links',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    subscriptionId: uuid('subscription_id')
      .references(() => parentSubscriptions.id, { onDelete: 'set null' }),
    parentId: uuid('parent_id')
      .notNull()
      .references(() => parents.id, { onDelete: 'cascade' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    parentStudentLinksUnique: unique('parent_student_links_parent_student_unique').on(
      table.parentId,
      table.studentId
    ),
    parentStudentLinksStudentIdx: index('idx_parent_student_links_student').on(table.studentId),
  })
);

export const subscriptionPayments = tenant.table(
  'subscription_payments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => parentSubscriptions.id, { onDelete: 'cascade' }),
    amountFcfa: integer('amount_fcfa').notNull(),
    paymentMethod: varchar('payment_method', { length: 20 }).notNull().default('cash'),
    paidAt: timestamp('paid_at', { withTimezone: true, mode: 'date' }).notNull(),
    recordedBy: uuid('recorded_by')
      .notNull()
      .references(() => users.id),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    subscriptionPaymentsMethodCheck: check(
      'subscription_payments_method_check',
      sql`${table.paymentMethod} IN ('cash', 'momo_mtn', 'momo_orange')`
    ),
    subscriptionPaymentsAmountNonNegativeCheck: check(
      'subscription_payments_amount_non_negative_check',
      sql`${table.amountFcfa} >= 0`
    ),
    subscriptionPaymentsSubscriptionIdx: index('idx_sub_payments_sub').on(table.subscriptionId),
  })
);

export const subscriptionReversals = tenant.table(
  'subscription_reversals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: text('tenant_id').notNull(),
    month: text('month').notNull(),
    amountCollected: numeric('amount_collected', { precision: 10, scale: 2 }).notNull().default('0'),
    commissionRate: numeric('commission_rate', { precision: 5, scale: 2 }).notNull().default('10.00'),
    schoolGain: numeric('school_gain', { precision: 10, scale: 2 }).notNull().default('0'),
    reversedAt: timestamp('reversed_at', { withTimezone: true, mode: 'date' }),
    notificationSentAt: timestamp('notification_sent_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    subscriptionReversalsMonthCheck: check(
      'subscription_reversals_month_check',
      sql`${table.month} ~ '^\d{4}-\d{2}$'`
    ),
    subscriptionReversalsTenantMonthUnique: unique('subscription_reversals_tenant_month_unique').on(
      table.tenantId,
      table.month
    ),
    subscriptionReversalsTenantIdx: index('idx_subscription_reversals_tenant').on(table.tenantId),
    subscriptionReversalsMonthIdx: index('idx_subscription_reversals_month').on(table.month),
    subscriptionReversalsReversedAtIdx: index('idx_subscription_reversals_reversed_at').on(table.reversedAt),
  })
);

export const smsUsageLog = tenant.table(
  'sms_usage_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => parentSubscriptions.id, { onDelete: 'cascade' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    month: varchar('month', { length: 7 }).notNull(),
    smsSentCount: integer('sms_sent_count').notNull().default(0),
    emailSentCount: integer('email_sent_count').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    smsUsageStudentMonthUnique: unique('sms_usage_log_student_month_unique').on(
      table.studentId,
      table.month
    ),
    smsUsageStudentMonthIdx: index('idx_sms_usage_student_month').on(table.studentId, table.month),
  })
);

export const reportCards = tenant.table(
  'report_cards',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    classId: uuid('class_id')
      .notNull()
      .references(() => classes.id),
    gradingPeriodId: uuid('grading_period_id')
      .notNull()
      .references(() => gradingPeriods.id, { onDelete: 'cascade' }),
    generalAverage: numeric('general_average', { precision: 8, scale: 3 }).notNull(),
    rank: integer('rank').notNull(),
    classAverage: numeric('class_average', { precision: 8, scale: 3 }).notNull(),
    classMinAverage: numeric('class_min_average', { precision: 8, scale: 3 }).notNull(),
    classMaxAverage: numeric('class_max_average', { precision: 8, scale: 3 }).notNull(),
    classHeadcount: integer('class_headcount').notNull(),
    classDecisionId: uuid('class_decision_id').references(() => classDecisions.id, {
      onDelete: 'set null',
    }),
    status: reportCardStatusEnum('status').notNull().default('generated'),
    generatedAt: timestamp('generated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
    publishedByUserId: uuid('published_by_user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    reportCardsStudentPeriodUnique: unique('report_cards_student_period_unique').on(
      table.studentId,
      table.gradingPeriodId
    ),
    reportCardsClassPeriodIdx: index('idx_report_cards_class_period').on(
      table.classId,
      table.gradingPeriodId
    ),
  })
);

export const reportCardLines = tenant.table(
  'report_card_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    reportCardId: uuid('report_card_id')
      .notNull()
      .references(() => reportCards.id, { onDelete: 'cascade' }),
    subjectId: uuid('subject_id').references(() => subjects.id, { onDelete: 'cascade' }),
    lineType: reportCardLineTypeEnum('line_type').notNull(),
    subjectAverage: numeric('subject_average', { precision: 8, scale: 3 }).notNull(),
    subjectCoefficient: numeric('subject_coefficient', { precision: 8, scale: 3 }).notNull(),
    subjectRank: integer('subject_rank'),
    teacherComment: text('teacher_comment'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    reportCardLinesSubjectUnique: uniqueIndex('report_card_lines_subject_unique')
      .on(table.reportCardId, table.subjectId)
      .where(sql`subject_id IS NOT NULL`),
    reportCardLinesConductUnique: uniqueIndex('report_card_lines_conduct_unique')
      .on(table.reportCardId)
      .where(sql`line_type = 'conduct'`),
    reportCardLinesReportIdx: index('idx_report_card_lines_report').on(table.reportCardId),
  })
);
