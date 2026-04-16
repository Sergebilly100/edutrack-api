import { createHash } from 'node:crypto';

import argon2 from 'argon2';
import { sql } from 'drizzle-orm';

import { db } from './db.js';
import { createTenantSchema } from './tenant-init.js';

const TENANT = {
  name: 'Groupe Scolaire Sainte-Marie de Cocody',
  subdomain: 'sainte-marie',
  schemaName: 'school_sainte_marie',
  // "starter" requested by product spec is mapped to current enum value "essential".
  plan: 'essential',
  status: 'active',
} as const;

const MAX_USERS_BY_PLAN = {
  essential: 5,
  pro: 20,
  establishment: 50,
} as const;

const DIRECTOR_EMAIL = 'directeur@sainte-marie.ci';
const SUPER_ADMIN_EMAIL = 'admin@edutrack.ci';
const DEFAULT_PASSWORD = 'Test1234!';

const TIME_SLOTS = [
  { label: '07h30 - 09h00', startTime: '07:30', endTime: '09:00', sortOrder: 1 },
  { label: '09h15 - 10h45', startTime: '09:15', endTime: '10:45', sortOrder: 2 },
  { label: '11h00 - 12h30', startTime: '11:00', endTime: '12:30', sortOrder: 3 },
  { label: '14h00 - 15h30', startTime: '14:00', endTime: '15:30', sortOrder: 4 },
] as const;

const ROOM_NAMES = ['Salle A1', 'Salle A2', 'Salle B1', 'Labo Sciences'] as const;

const TEACHER_SEED = [
  {
    firstName: 'Kouadio',
    lastName: 'Nguessan',
    fullName: 'Kouadio Nguessan',
    email: 'kouadio.nguessan@sainte-marie.ci',
    phone: '+225070100001',
    checkInToken: '0d9d0f07-7b92-44c8-a0cf-28f8906ab001',
    type: 'vacataire',
    subjects: ['Mathematiques'],
    hourlyRate: 5000,
  },
  {
    firstName: 'Aminata',
    lastName: 'Kone',
    fullName: 'Aminata Kone',
    email: 'aminata.kone@sainte-marie.ci',
    phone: '+225070100002',
    checkInToken: '1bb0f4f3-5cd2-45a8-b45d-8b9f6c19c002',
    type: 'vacataire',
    subjects: ['Francais'],
    hourlyRate: 4500,
  },
  {
    firstName: 'Blaise',
    lastName: 'Yao',
    fullName: 'Blaise Yao',
    email: 'blaise.yao@sainte-marie.ci',
    phone: '+225070100003',
    checkInToken: '2a6bf42f-49e4-47b8-8425-7e1a7b67d003',
    type: 'vacataire',
    subjects: ['Physique-Chimie'],
    hourlyRate: 5500,
  },
  {
    firstName: 'Mariam',
    lastName: 'Coulibaly',
    fullName: 'Mariam Coulibaly',
    email: 'mariam.coulibaly@sainte-marie.ci',
    phone: '+225070100004',
    checkInToken: '31a89fb4-86f5-4d4e-bf56-f14bd86bb004',
    type: 'vacataire',
    subjects: ['Anglais'],
    hourlyRate: 4800,
  },
  {
    firstName: 'Jean',
    lastName: 'Traore',
    fullName: 'Jean Traore',
    email: 'jean.traore@sainte-marie.ci',
    phone: '+225070100005',
    checkInToken: '4c4ff73d-7f31-4faa-9792-6d038747f005',
    type: 'vacataire',
    subjects: ['Histoire-Geographie'],
    hourlyRate: 5000,
  },
  {
    firstName: 'Rosine',
    lastName: 'Bamba',
    fullName: 'Rosine Bamba',
    email: 'rosine.bamba@sainte-marie.ci',
    phone: '+225070100006',
    checkInToken: '5db59d8d-9f74-4ca2-8df7-df32ba3de006',
    type: 'vacataire',
    subjects: ['SVT'],
    hourlyRate: 5200,
  },
] as const;

const CLASSES = [
  { name: '3ème A', level: '3ème' },
  { name: '2nde B', level: '2nde' },
  { name: 'Terminale C', level: 'Terminale' },
] as const;

const FIRST_NAMES = [
  'Aya',
  'Awa',
  'Koffi',
  'Mireille',
  'Yann',
  'Fatou',
  'Kevin',
  'Rosine',
  'Cedric',
  'Mariam',
  'Yasmine',
] as const;

const LAST_NAMES = [
  'Kouame',
  'Kouassi',
  'Diallo',
  'Nguessan',
  'Traore',
  'Yao',
  'Bamba',
  'Kone',
  'Ouattara',
  'Soro',
  'Coulibaly',
] as const;

type IdRow = { id: string };

type RoomRow = { id: string; name: string };

type SlotRow = {
  id: string;
  label: string;
  start_time: string;
  end_time: string;
  sort_order: number;
};

type TeacherRow = { id: string; username: string; primary_subject: string };

type ClassRow = { id: string; name: string };

type StudentRow = { id: string; class_id: string };

type ScheduleRow = {
  id: string;
  teacher_id: string;
  class_id: string;
  room_id: string;
  day_of_week: number;
  slot_start: string;
};

const deterministicHex = (seed: string, length: number): string => {
  const digest = createHash('sha256').update(seed).digest('hex');
  if (digest.length >= length) return digest.slice(0, length);
  return `${digest}${deterministicHex(`${seed}:x`, length - digest.length)}`;
};

const deterministicScore = (seed: string): number => {
  const digest = createHash('sha256').update(seed).digest();
  const value = digest.readUInt32BE(0);
  return value / 0xffffffff;
};

const deterministicQrToken = (seed: string): string => deterministicHex(seed, 64);

const formatDate = (date: Date): string => {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${date.getUTCDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const addDays = (date: Date, days: number): Date => {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
};

const dayOfWeekFromDate = (date: Date): number => {
  const day = date.getUTCDay();
  return day === 0 ? 7 : day;
};

const getLastTwoSchoolWeeksDates = (): string[] => {
  const today = new Date();
  const dates: string[] = [];
  for (let offset = 13; offset >= 0; offset -= 1) {
    const candidate = addDays(today, -offset);
    const day = dayOfWeekFromDate(candidate);
    if (day >= 1 && day <= 5) {
      dates.push(formatDate(candidate));
    }
  }
  return dates;
};

const addMinutesToTime = (time: string, minutesToAdd: number): string => {
  const [hourRaw, minuteRaw] = time.slice(0, 5).split(':');
  const totalMinutes = Number(hourRaw) * 60 + Number(minuteRaw) + minutesToAdd;
  const hour = Math.floor(totalMinutes / 60)
    .toString()
    .padStart(2, '0');
  const minute = (totalMinutes % 60).toString().padStart(2, '0');
  return `${hour}:${minute}`;
};

const buildStudents = (classId: string, classIndex: number) => {
  return Array.from({ length: 10 }).map((_, studentIndex) => {
    const firstName = FIRST_NAMES[(studentIndex + classIndex * 3) % FIRST_NAMES.length];
    const lastName = LAST_NAMES[(studentIndex + classIndex * 2) % LAST_NAMES.length];
    const phoneSeed = classIndex * 10 + studentIndex + 1;
    return {
      classId,
      firstName,
      lastName,
      parentPhone: `2250${phoneSeed.toString().padStart(9, '0')}`,
      parentPhone2: `2250${(100 + phoneSeed).toString().padStart(9, '0')}`,
    };
  });
};

const main = async (): Promise<void> => {
  const periodValidFrom = formatDate(addDays(new Date(), -21));
  const periodValidTo = formatDate(addDays(new Date(), 21));
  const lastTwoSchoolWeeks = getLastTwoSchoolWeeksDates();
  const teacherPasswordHash = await argon2.hash(DEFAULT_PASSWORD);
  const directorPasswordHash = await argon2.hash(DEFAULT_PASSWORD);
  const superAdminPasswordHash = await argon2.hash(DEFAULT_PASSWORD);

  console.info('[seed] Creating tenant schema and applying tenant migrations...');
  await createTenantSchema(TENANT.schemaName);

  console.info('[seed] Upserting tenant in public schema...');
  const tenantResult = await db.execute<{ id: string }>(sql`
    INSERT INTO public.tenants (name, subdomain, schema_name, plan, status, max_users, onboarding_completed)
    VALUES (
      ${TENANT.name},
      ${TENANT.subdomain},
      ${TENANT.schemaName},
      ${TENANT.plan},
      ${TENANT.status},
      ${MAX_USERS_BY_PLAN[TENANT.plan]},
      true
    )
    ON CONFLICT (subdomain)
    DO UPDATE SET
      name = EXCLUDED.name,
      schema_name = EXCLUDED.schema_name,
      plan = EXCLUDED.plan,
      status = EXCLUDED.status,
      max_users = EXCLUDED.max_users,
      onboarding_completed = true,
      updated_at = NOW()
    RETURNING id
  `);

  const tenantId = tenantResult.rows[0]?.id;
  if (!tenantId) {
    throw new Error('[seed] Failed to upsert tenant row');
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL search_path TO "${TENANT.schemaName}", public`));

    console.info('[seed] Resetting tenant data...');
    await tx.execute(sql`DELETE FROM position_assignments`);
    await tx.execute(sql`DELETE FROM salary_records`);
    await tx.execute(sql`DELETE FROM admin_positions`);
    await tx.execute(sql`DELETE FROM documents`);
    await tx.execute(sql`DELETE FROM attendances_student`);
    await tx.execute(sql`DELETE FROM attendances_teacher`);
    await tx.execute(sql`DELETE FROM notifications_log`);
    await tx.execute(sql`DELETE FROM schedules`);
    await tx.execute(sql`DELETE FROM schedule_periods`);
    await tx.execute(sql`DELETE FROM students`);
    await tx.execute(sql`DELETE FROM classes`);
    await tx.execute(sql`DELETE FROM teachers`);
    await tx.execute(sql`DELETE FROM users`);
    await tx.execute(sql`DELETE FROM rooms`);
    await tx.execute(sql`DELETE FROM time_slots`);

    console.info('[seed] Inserting rooms and time slots...');
    for (const roomName of ROOM_NAMES) {
      await tx.execute(sql`
        INSERT INTO rooms (name, qr_token, is_active)
        VALUES (${roomName}, ${deterministicQrToken(`${TENANT.schemaName}:${roomName}`)}, true)
      `);
    }

    for (const slot of TIME_SLOTS) {
      await tx.execute(sql`
        INSERT INTO time_slots (label, start_time, end_time, sort_order)
        VALUES (${slot.label}, ${slot.startTime}, ${slot.endTime}, ${slot.sortOrder})
      `);
    }

    const directorUser = await tx.execute<IdRow>(sql`
      INSERT INTO users (role, name, phone, email, password_hash, is_active)
      VALUES (
        'director',
        'Directeur Sainte-Marie',
        '+225070999999',
        ${DIRECTOR_EMAIL},
        ${directorPasswordHash},
        true
      )
      RETURNING id
    `);
    const directorId = directorUser.rows[0]?.id;
    if (!directorId) {
      throw new Error('[seed] Failed to create director user');
    }

    const secretaryUser = await tx.execute<IdRow>(sql`
      INSERT INTO users (role, name, phone, email, password_hash, is_active)
      VALUES (
        'secretary',
        'Secrétaire Sainte-Marie',
        '+225070888888',
        'secretariat@sainte-marie.ci',
        ${teacherPasswordHash},
        true
      )
      RETURNING id
    `);

    const secretaryId = secretaryUser.rows[0]?.id;
    if (!secretaryId) {
      throw new Error('[seed] Failed to create secretary user');
    }

    const superAdminUser = await tx.execute<IdRow>(sql`
      INSERT INTO users (role, name, phone, email, password_hash, is_active)
      VALUES (
        'super_admin',
        'Super Admin EduTrack',
        '+225070777777',
        ${SUPER_ADMIN_EMAIL},
        ${superAdminPasswordHash},
        true
      )
      RETURNING id
    `);
    const superAdminId = superAdminUser.rows[0]?.id;
    if (!superAdminId) {
      throw new Error('[seed] Failed to create super admin user');
    }

    console.info('[seed] Inserting teachers (vacataires) with stable check-in tokens...');
    for (const teacher of TEACHER_SEED) {
      const userResult = await tx.execute<IdRow>(sql`
        INSERT INTO users (role, name, phone, email, password_hash, is_active)
        VALUES (
          'teacher',
          ${teacher.fullName},
          ${teacher.phone},
          ${teacher.email},
          ${teacherPasswordHash},
          true
        )
        RETURNING id
      `);

      const userId = userResult.rows[0]?.id;
      if (!userId) {
        throw new Error(`[seed] Failed to create teacher user ${teacher.fullName}`);
      }

      const subjectsArray = sql`ARRAY[${sql.join(
        teacher.subjects.map((subject) => sql`${subject}`),
        sql`, `
      )}]::text[]`;

      await tx.execute(sql`
        INSERT INTO teachers (user_id, username, type, subjects, hourly_rate)
        VALUES (
          ${userId},
          ${teacher.checkInToken},
          ${teacher.type}::teacher_type,
          ${subjectsArray},
          ${teacher.hourlyRate}
        )
      `);
    }

    console.info('[seed] Inserting classes and students...');
    for (const klass of CLASSES) {
      await tx.execute(sql`
        INSERT INTO classes (name, level, student_count)
        VALUES (${klass.name}, ${klass.level}, 10)
      `);
    }

    const classesResult = await tx.execute<ClassRow>(sql`
      SELECT id, name
      FROM classes
      ORDER BY created_at ASC
    `);

    for (const [classIndex, klass] of classesResult.rows.entries()) {
      const students = buildStudents(klass.id, classIndex);
      for (const student of students) {
        await tx.execute(sql`
          INSERT INTO students (class_id, first_name, last_name, parent_phone, parent_phone_2, is_active)
          VALUES (
            ${student.classId},
            ${student.firstName},
            ${student.lastName},
            ${student.parentPhone},
            ${student.parentPhone2},
            true
          )
        `);
      }
    }

    console.info('[seed] Inserting active schedule period...');
    const periodResult = await tx.execute<IdRow>(sql`
      INSERT INTO schedule_periods (name, valid_from, valid_to, is_active, created_by)
      VALUES (
        ${`Période active ${periodValidFrom} → ${periodValidTo}`},
        ${periodValidFrom},
        ${periodValidTo},
        true,
        ${directorId}
      )
      RETURNING id
    `);

    const schedulePeriodId = periodResult.rows[0]?.id;
    if (!schedulePeriodId) {
      throw new Error('[seed] Failed to create active schedule period');
    }

    const roomsResult = await tx.execute<RoomRow>(sql`
      SELECT id, name
      FROM rooms
      ORDER BY name
    `);
    const slotsResult = await tx.execute<SlotRow>(sql`
      SELECT id, label, start_time::text, end_time::text, sort_order
      FROM time_slots
      ORDER BY sort_order
    `);
    const teachersResult = await tx.execute<TeacherRow>(sql`
      SELECT
        t.id,
        t.username,
        COALESCE(t.subjects[1], 'Cours') AS primary_subject
      FROM teachers t
      ORDER BY t.created_at ASC
    `);

    const firstTeacherId = teachersResult.rows[0]?.id;
    const secondTeacherId = teachersResult.rows[1]?.id;
    if (!firstTeacherId || !secondTeacherId) {
      throw new Error('[seed] Missing teachers required for salary records');
    }

    await tx.execute(sql`
      INSERT INTO admin_positions (name, permissions, created_by)
      VALUES (
        'Censeur',
        ${JSON.stringify(['teachers.view', 'students.view', 'attendance.view'])}::jsonb,
        ${directorId}
      )
      RETURNING id
    `);

    await tx.execute(sql`
      INSERT INTO position_assignments (user_id, position_id, assigned_by)
      SELECT
        ${secretaryId},
        ap.id,
        ${directorId}
      FROM admin_positions ap
      WHERE ap.name = 'Censeur'
      LIMIT 1
    `);

    const monthDate = '2025-01-01';

    await tx.execute(sql`
      INSERT INTO salary_records (
        teacher_id,
        period_month,
        hours_planned,
        hours_done,
        hourly_rate,
        total_fcfa,
        status,
        notes,
        paid_at,
        paid_by
      )
      VALUES
      (
        ${firstTeacherId},
        ${monthDate},
        48.00,
        45.50,
        5000,
        227500,
        'pending',
        'Bilan mois courant',
        NULL,
        NULL
      ),
      (
        ${secondTeacherId},
        ${monthDate},
        42.00,
        41.00,
        4500,
        184500,
        'paid',
        'Règlement validé',
        NOW(),
        ${directorId}
      )
    `);

    const roomByName = new Map(roomsResult.rows.map((room) => [room.name, room.id]));
    const classByIndex = classesResult.rows;
    const slotByIndex = slotsResult.rows;

    console.info('[seed] Inserting schedules (5 days x 4 slots x 3 classes)...');
    for (let day = 1; day <= 5; day += 1) {
      for (const [slotIndex, slot] of slotByIndex.entries()) {
        for (const [classIndex, klass] of classByIndex.entries()) {
          const teacher = teachersResult.rows[(day + slotIndex + classIndex * 2) % teachersResult.rows.length];
          const roomName = ROOM_NAMES[(day + slotIndex + classIndex) % ROOM_NAMES.length];
          const roomId = roomByName.get(roomName);
          if (!teacher || !roomId) {
            throw new Error('[seed] Missing teacher/room while building schedule grid');
          }

          await tx.execute(sql`
            INSERT INTO schedules (
              schedule_period_id,
              teacher_id,
              class_id,
              room_id,
              time_slot_id,
              day_of_week,
              subject,
              is_active
            )
            VALUES (
              ${schedulePeriodId},
              ${teacher.id},
              ${klass.id},
              ${roomId},
              ${slot.id},
              ${day},
              ${teacher.primary_subject},
              true
            )
          `);
        }
      }
    }

    const schedulesResult = await tx.execute<ScheduleRow>(sql`
      SELECT
        s.id,
        s.teacher_id,
        s.class_id,
        s.room_id,
        s.day_of_week,
        ts.start_time::text AS slot_start
      FROM schedules s
      INNER JOIN time_slots ts ON ts.id = s.time_slot_id
      WHERE s.schedule_period_id = ${schedulePeriodId}
      ORDER BY s.day_of_week, ts.sort_order
    `);

    const studentsResult = await tx.execute<StudentRow>(sql`
      SELECT id, class_id
      FROM students
      ORDER BY created_at ASC
    `);
    const studentsByClass = new Map<string, string[]>();
    for (const student of studentsResult.rows) {
      const existing = studentsByClass.get(student.class_id) ?? [];
      existing.push(student.id);
      studentsByClass.set(student.class_id, existing);
    }

    console.info('[seed] Inserting teacher attendances (past 2 weeks: present/absent/non-pointé)...');
    let teacherAttendanceCount = 0;
    for (const schedule of schedulesResult.rows) {
      for (const date of lastTwoSchoolWeeks) {
        if (dayOfWeekFromDate(new Date(`${date}T00:00:00.000Z`)) !== schedule.day_of_week) {
          continue;
        }

        const outcomeScore = deterministicScore(`${schedule.id}|${date}|teacher`);
        if (outcomeScore >= 0.86) {
          continue; // non-pointé
        }

        if (outcomeScore < 0.67) {
          const lateMinutes = Math.floor(deterministicScore(`${schedule.id}|${date}|late`) * 8);
          const checkedAt = addMinutesToTime(schedule.slot_start, lateMinutes);
          const mismatch = deterministicScore(`${schedule.id}|${date}|mismatch`) < 0.11;
          const roomPool = roomsResult.rows.filter((room) => room.id !== schedule.room_id);
          const mismatchRoom = roomPool[Math.floor(deterministicScore(`${schedule.id}|${date}|room`) * roomPool.length)];
          const scannedRoomId = mismatch && mismatchRoom ? mismatchRoom.id : schedule.room_id;

          await tx.execute(sql`
            INSERT INTO attendances_teacher (
              teacher_id,
              schedule_id,
              date,
              status,
              checked_in_at,
              late_minutes,
              room_scanned_id,
              room_scan_start_at,
              room_scan_end_at,
              room_mismatch,
              qr_alert_sent,
              marked_by,
              note
            )
            VALUES (
              ${schedule.teacher_id},
              ${schedule.id},
              ${date},
              'present',
              ${`${date}T${checkedAt}:00.000Z`},
              ${lateMinutes},
              ${scannedRoomId},
              ${`${date}T${addMinutesToTime(checkedAt, -1)}:00.000Z`},
              ${`${date}T${addMinutesToTime(checkedAt, 3)}:00.000Z`},
              ${mismatch},
              ${mismatch},
              ${directorId},
              ${mismatch ? 'Scan salle incorrecte' : 'Présence validée'}
            )
          `);
          teacherAttendanceCount += 1;
          continue;
        }

        await tx.execute(sql`
          INSERT INTO attendances_teacher (
            teacher_id,
            schedule_id,
            date,
            status,
            checked_in_at,
            late_minutes,
            room_scanned_id,
            room_scan_start_at,
            room_scan_end_at,
            room_mismatch,
            qr_alert_sent,
            marked_by,
            note
          )
          VALUES (
            ${schedule.teacher_id},
            ${schedule.id},
            ${date},
            'absent',
            NULL,
            NULL,
            NULL,
            NULL,
            NULL,
            false,
            false,
            ${directorId},
            'Absence relevée'
          )
        `);
        teacherAttendanceCount += 1;
      }
    }

    const todayDate = formatDate(new Date());
    const todayDay = dayOfWeekFromDate(new Date(`${todayDate}T00:00:00.000Z`));
    const todaySchedules = schedulesResult.rows.filter((row) => row.day_of_week === todayDay);

    // Guarantee dashboard scenario for today:
    // - >=3 planned courses (already true with seeded timetable)
    // - 2 present, 1 absent, 1 unmarked
    if (todaySchedules.length >= 4) {
      const [presentA, presentB, absentA, unmarkedA] = todaySchedules;

      const upsertTeacherAttendance = async (input: {
        schedule: ScheduleRow;
        status: 'present' | 'absent';
        checkedAt?: string;
        note: string;
      }) => {
        await tx.execute(sql`
          INSERT INTO attendances_teacher (
            teacher_id,
            schedule_id,
            date,
            status,
            checked_in_at,
            late_minutes,
            room_scanned_id,
            room_scan_start_at,
            room_scan_end_at,
            room_mismatch,
            qr_alert_sent,
            marked_by,
            note
          )
          VALUES (
            ${input.schedule.teacher_id},
            ${input.schedule.id},
            ${todayDate},
            ${input.status},
            ${input.checkedAt ? `${todayDate}T${input.checkedAt}:00.000Z` : null},
            ${input.status === 'present' ? 0 : null},
            ${input.status === 'present' ? input.schedule.room_id : null},
            ${input.checkedAt ? `${todayDate}T${addMinutesToTime(input.checkedAt, -1)}:00.000Z` : null},
            ${input.checkedAt ? `${todayDate}T${addMinutesToTime(input.checkedAt, 2)}:00.000Z` : null},
            false,
            false,
            ${directorId},
            ${input.note}
          )
          ON CONFLICT (teacher_id, schedule_id, date)
          DO UPDATE SET
            status = EXCLUDED.status,
            checked_in_at = EXCLUDED.checked_in_at,
            late_minutes = EXCLUDED.late_minutes,
            room_scanned_id = EXCLUDED.room_scanned_id,
            room_scan_start_at = EXCLUDED.room_scan_start_at,
            room_scan_end_at = EXCLUDED.room_scan_end_at,
            room_mismatch = EXCLUDED.room_mismatch,
            qr_alert_sent = EXCLUDED.qr_alert_sent,
            marked_by = EXCLUDED.marked_by,
            note = EXCLUDED.note
        `);
      };

      await upsertTeacherAttendance({
        schedule: presentA,
        status: 'present',
        checkedAt: presentA.slot_start.slice(0, 5),
        note: 'Présence garantie seed (1/2)',
      });
      await upsertTeacherAttendance({
        schedule: presentB,
        status: 'present',
        checkedAt: addMinutesToTime(presentB.slot_start.slice(0, 5), 3),
        note: 'Présence garantie seed (2/2)',
      });
      await upsertTeacherAttendance({
        schedule: absentA,
        status: 'absent',
        note: 'Absence garantie seed',
      });
      await tx.execute(sql`
        DELETE FROM attendances_teacher
        WHERE teacher_id = ${unmarkedA.teacher_id}
          AND schedule_id = ${unmarkedA.id}
          AND date = ${todayDate}
      `);
    }

    console.info('[seed] Inserting student attendances (past 2 weeks)...');
    let studentAttendanceCount = 0;
    for (const schedule of schedulesResult.rows) {
      const classStudentIds = studentsByClass.get(schedule.class_id) ?? [];
      if (classStudentIds.length === 0) continue;

      for (const date of lastTwoSchoolWeeks) {
        if (dayOfWeekFromDate(new Date(`${date}T00:00:00.000Z`)) !== schedule.day_of_week) {
          continue;
        }

        for (const studentId of classStudentIds) {
          const score = deterministicScore(`${studentId}|${schedule.id}|${date}|student`);
          if (score >= 0.9) {
            continue; // non-pointé
          }

          const status = score < 0.8 ? 'present' : 'absent';
          await tx.execute(sql`
            INSERT INTO attendances_student (
              student_id,
              schedule_id,
              date,
              status,
              marked_by,
              note
            )
            VALUES (
              ${studentId},
              ${schedule.id},
              ${date},
              ${status}::attendance_student_status,
              ${directorId},
              ${status === 'present' ? 'Présence en classe' : 'Absence signalée'}
            )
          `);
          studentAttendanceCount += 1;
        }
      }
    }

    console.info(
      `[seed] Stats: teachers=${teachersResult.rows.length}, classes=${classesResult.rows.length}, students=${studentsResult.rows.length}, schedules=${schedulesResult.rows.length}, att_teacher=${teacherAttendanceCount}, att_student=${studentAttendanceCount}`
    );
  });

  console.info('[seed] Seed completed successfully');
  console.info(`[seed] Tenant: ${TENANT.subdomain} (${TENANT.schemaName})`);
  console.info(`[seed] Director login ready: ${DIRECTOR_EMAIL} / ${DEFAULT_PASSWORD}`);
  console.info(
    `[seed] Super admin login ready: ${SUPER_ADMIN_EMAIL} / ${DEFAULT_PASSWORD} (schema: ${TENANT.schemaName})`
  );
};

void main().catch((error) => {
  console.error('[seed] Failed:', error);
  process.exitCode = 1;
});
