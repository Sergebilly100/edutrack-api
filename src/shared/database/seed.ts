import { randomBytes } from 'node:crypto';

import argon2 from 'argon2';
import { sql } from 'drizzle-orm';

import { db } from './db.js';
import { createTenantSchema } from './tenant-init.js';
import { generateUsername } from '../utils/username.js';

const TENANT = {
  name: 'Lycee Sainte-Marie',
  subdomain: 'sainte-marie',
  schemaName: 'school_sainte_marie',
  plan: 'pro',
  status: 'active',
} as const;

const DEFAULT_PASSWORD = 'edutrack2024';

const TIME_SLOTS = [
  { label: '7h30 - 9h00', startTime: '07:30', endTime: '09:00', sortOrder: 1 },
  { label: '9h00 - 10h30', startTime: '09:00', endTime: '10:30', sortOrder: 2 },
  { label: '10h30 - 12h00', startTime: '10:30', endTime: '12:00', sortOrder: 3 },
  { label: '12h00 - 13h30', startTime: '12:00', endTime: '13:30', sortOrder: 4 },
  { label: '13h30 - 15h00', startTime: '13:30', endTime: '15:00', sortOrder: 5 },
  { label: '15h00 - 16h30', startTime: '15:00', endTime: '16:30', sortOrder: 6 },
] as const;

const ROOM_NAMES = ['Salle A1', 'Salle A2', 'Labo Sciences', 'Salle Langues'] as const;

const TEACHER_SEED = [
  {
    firstName: 'Ibrahim',
    lastName: 'Diallo',
    fullName: 'Ibrahim Diallo',
    type: 'vacataire',
    subjects: ['Mathematiques'],
    hourlyRate: 5000,
  },
  {
    firstName: 'Fatima',
    lastName: 'Kone',
    fullName: 'Fatima Kone',
    type: 'vacataire',
    subjects: ['Francais'],
    hourlyRate: 4500,
  },
  {
    firstName: 'Mamadou',
    lastName: 'Traore',
    fullName: 'Mamadou Traore',
    type: 'permanent',
    subjects: ['SVT'],
    hourlyRate: null,
  },
  {
    firstName: 'Aminata',
    lastName: 'Bamba',
    fullName: 'Aminata Bamba',
    type: 'vacataire',
    subjects: ['Anglais'],
    hourlyRate: 4000,
  },
  {
    firstName: 'Serge',
    lastName: 'Yao',
    fullName: 'Serge Yao',
    type: 'vacataire',
    subjects: ['Physique-Chimie'],
    hourlyRate: 5000,
  },
] as const;

const CLASSES = [
  { name: '3eme A', level: '3eme' },
  { name: '3eme B', level: '3eme' },
  { name: 'Terminale C', level: 'Terminale' },
] as const;

const FIRST_NAMES = [
  'Aya',
  'Koffi',
  'Awa',
  'Yannick',
  'Mireille',
  'Cedric',
  'Mariam',
  'Jean',
  'Nadia',
  'Wilfried',
] as const;

const LAST_NAMES = [
  'Kouame',
  'Kone',
  'Diallo',
  'Bamba',
  'Traore',
  'Yao',
  'Kouassi',
  'NGuessan',
  'Ouattara',
  'Soro',
] as const;

type IdRow = { id: string };

type RoomRow = { id: string; name: string };

type SlotRow = { id: string; label: string };

type TeacherRow = { id: string; username: string };

type ClassRow = { id: string; name: string };

type ScheduleRow = { id: string; teacher_username: string; day_of_week: number; slot_label: string };

const generateQrToken = (): string => randomBytes(32).toString('hex');

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

const getCurrentWeekBounds = (): { monday: string; friday: string } => {
  const now = new Date();
  const day = now.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  const mondayDate = addDays(now, -daysSinceMonday);
  const fridayDate = addDays(mondayDate, 4);

  return {
    monday: formatDate(mondayDate),
    friday: formatDate(fridayDate),
  };
};

const buildStudents = (classId: string, classIndex: number) => {
  return FIRST_NAMES.map((firstName, studentIndex) => {
    const lastName = LAST_NAMES[(studentIndex + classIndex * 2) % LAST_NAMES.length];
    const phoneSuffix = `${classIndex}${studentIndex}`.padStart(2, '0');
    return {
      classId,
      firstName,
      lastName,
      parentPhone: `225070000${phoneSuffix}11`,
      parentPhone2: `225010000${phoneSuffix}22`,
    };
  });
};

const main = async (): Promise<void> => {
  const week = getCurrentWeekBounds();
  const teacherPasswordHash = await argon2.hash(DEFAULT_PASSWORD);
  const directorPasswordHash = await argon2.hash('director2024');

  console.info('[seed] Creating tenant schema and applying tenant migrations...');
  await createTenantSchema(TENANT.schemaName);

  console.info('[seed] Upserting tenant in public schema...');
  const tenantResult = await db.execute<{ id: string }>(sql`
    INSERT INTO public.tenants (name, subdomain, schema_name, plan, status)
    VALUES (${TENANT.name}, ${TENANT.subdomain}, ${TENANT.schemaName}, ${TENANT.plan}, ${TENANT.status})
    ON CONFLICT (subdomain)
    DO UPDATE SET
      name = EXCLUDED.name,
      schema_name = EXCLUDED.schema_name,
      plan = EXCLUDED.plan,
      status = EXCLUDED.status,
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
    await tx.execute(sql`DELETE FROM attendances_student`);
    await tx.execute(sql`DELETE FROM attendances_teacher`);
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
        VALUES (${roomName}, ${generateQrToken()}, true)
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
        'Direction Sainte-Marie',
        '2250701234567',
        'direction@sainte-marie.edu.ci',
        ${directorPasswordHash},
        true
      )
      RETURNING id
    `);
    const directorId = directorUser.rows[0]?.id;
    if (!directorId) {
      throw new Error('[seed] Failed to create director user');
    }

    console.info('[seed] Inserting teachers with generated usernames...');
    const existingUsernames: string[] = [];
    for (const teacher of TEACHER_SEED) {
      const userResult = await tx.execute<IdRow>(sql`
        INSERT INTO users (role, name, email, password_hash, is_active)
        VALUES (
          'teacher',
          ${teacher.fullName},
          ${`${teacher.firstName.toLowerCase()}.${teacher.lastName.toLowerCase()}@edutrack.local`},
          ${teacherPasswordHash},
          true
        )
        RETURNING id
      `);

      const userId = userResult.rows[0]?.id;
      if (!userId) {
        throw new Error(`[seed] Failed to create teacher user ${teacher.fullName}`);
      }

      const username = generateUsername(teacher.lastName, teacher.firstName, existingUsernames);
      existingUsernames.push(username);

      const subjectsArray = sql`ARRAY[${sql.join(
        teacher.subjects.map((subject) => sql`${subject}`),
        sql`, `
      )}]::text[]`;

      await tx.execute(sql`
        INSERT INTO teachers (user_id, username, type, subjects, hourly_rate)
        VALUES (
          ${userId},
          ${username},
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
      ORDER BY name
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

    console.info('[seed] Inserting active schedule period for current week...');
    const periodResult = await tx.execute<IdRow>(sql`
      INSERT INTO schedule_periods (name, valid_from, valid_to, is_active, created_by)
      VALUES (
        ${`Semaine du ${week.monday} au ${week.friday}`},
        ${week.monday},
        ${week.friday},
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
      SELECT id, label
      FROM time_slots
      ORDER BY sort_order
    `);
    const teachersResult = await tx.execute<TeacherRow>(sql`
      SELECT id, username
      FROM teachers
      ORDER BY username
    `);

    const roomByName = new Map(roomsResult.rows.map((room) => [room.name, room.id]));
    const slotByLabel = new Map(slotsResult.rows.map((slot) => [slot.label, slot.id]));
    const teacherByUsername = new Map(teachersResult.rows.map((teacher) => [teacher.username, teacher.id]));
    const classByName = new Map(classesResult.rows.map((klass) => [klass.name, klass.id]));

    const scheduleBlueprint = [
      { teacher: 'diallo.ibra', className: '3eme A', room: 'Salle A1', slot: '7h30 - 9h00', day: 1, subject: 'Mathematiques' },
      { teacher: 'diallo.ibra', className: '3eme B', room: 'Salle A2', slot: '9h00 - 10h30', day: 3, subject: 'Mathematiques' },
      { teacher: 'diallo.ibra', className: 'Terminale C', room: 'Labo Sciences', slot: '13h30 - 15h00', day: 5, subject: 'Mathematiques' },
      { teacher: 'kone.fati', className: '3eme B', room: 'Salle Langues', slot: '10h30 - 12h00', day: 1, subject: 'Francais' },
      { teacher: 'kone.fati', className: '3eme A', room: 'Salle Langues', slot: '12h00 - 13h30', day: 2, subject: 'Francais' },
      { teacher: 'kone.fati', className: 'Terminale C', room: 'Salle A2', slot: '15h00 - 16h30', day: 4, subject: 'Francais' },
      { teacher: 'traore.mama', className: 'Terminale C', room: 'Labo Sciences', slot: '7h30 - 9h00', day: 2, subject: 'SVT' },
      { teacher: 'traore.mama', className: '3eme A', room: 'Labo Sciences', slot: '9h00 - 10h30', day: 4, subject: 'SVT' },
      { teacher: 'traore.mama', className: '3eme B', room: 'Labo Sciences', slot: '12h00 - 13h30', day: 5, subject: 'SVT' },
      { teacher: 'bamba.amin', className: '3eme A', room: 'Salle Langues', slot: '13h30 - 15h00', day: 1, subject: 'Anglais' },
      { teacher: 'bamba.amin', className: '3eme B', room: 'Salle Langues', slot: '15h00 - 16h30', day: 3, subject: 'Anglais' },
      { teacher: 'bamba.amin', className: 'Terminale C', room: 'Salle A1', slot: '10h30 - 12h00', day: 5, subject: 'Anglais' },
      { teacher: 'yao.serg', className: 'Terminale C', room: 'Labo Sciences', slot: '10h30 - 12h00', day: 2, subject: 'Physique-Chimie' },
      { teacher: 'yao.serg', className: '3eme A', room: 'Salle A2', slot: '7h30 - 9h00', day: 4, subject: 'Physique-Chimie' },
      { teacher: 'yao.serg', className: '3eme B', room: 'Salle A1', slot: '9h00 - 10h30', day: 5, subject: 'Physique-Chimie' },
    ] as const;

    console.info('[seed] Inserting schedules linked to period + rooms...');
    for (const schedule of scheduleBlueprint) {
      const teacherId = teacherByUsername.get(schedule.teacher);
      const classId = classByName.get(schedule.className);
      const roomId = roomByName.get(schedule.room);
      const timeSlotId = slotByLabel.get(schedule.slot);

      if (!teacherId || !classId || !roomId || !timeSlotId) {
        throw new Error(`[seed] Missing FK data for schedule ${JSON.stringify(schedule)}`);
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
          ${teacherId},
          ${classId},
          ${roomId},
          ${timeSlotId},
          ${schedule.day},
          ${schedule.subject},
          true
        )
      `);
    }

    const schedulesResult = await tx.execute<ScheduleRow>(sql`
      SELECT
        s.id,
        t.username AS teacher_username,
        s.day_of_week,
        ts.label AS slot_label
      FROM schedules s
      INNER JOIN teachers t ON t.id = s.teacher_id
      INNER JOIN time_slots ts ON ts.id = s.time_slot_id
      ORDER BY s.day_of_week, ts.sort_order
    `);

    const scheduleByComposite = new Map(
      schedulesResult.rows.map((row) => [`${row.teacher_username}|${row.day_of_week}|${row.slot_label}`, row.id])
    );

    const today = new Date();
    const twoDaysAgo = formatDate(addDays(today, -2));
    const yesterday = formatDate(addDays(today, -1));
    const todayDate = formatDate(today);

    console.info('[seed] Inserting teacher attendances (mismatch + late included)...');
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
        ${teacherByUsername.get('diallo.ibra')!},
        ${scheduleByComposite.get('diallo.ibra|1|7h30 - 9h00')!},
        ${twoDaysAgo},
        'present',
        ${`${twoDaysAgo}T07:29:00.000Z`},
        0,
        ${roomByName.get('Salle A1')!},
        ${`${twoDaysAgo}T07:28:00.000Z`},
        ${`${twoDaysAgo}T09:02:00.000Z`},
        false,
        false,
        ${directorId},
        'A l heure'
      )
    `);

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
        ${teacherByUsername.get('kone.fati')!},
        ${scheduleByComposite.get('kone.fati|1|10h30 - 12h00')!},
        ${yesterday},
        'late',
        ${`${yesterday}T10:42:00.000Z`},
        12,
        ${roomByName.get('Salle Langues')!},
        ${`${yesterday}T10:41:00.000Z`},
        ${`${yesterday}T12:01:00.000Z`},
        false,
        false,
        ${directorId},
        'Retard trafic'
      )
    `);

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
        ${teacherByUsername.get('traore.mama')!},
        ${scheduleByComposite.get('traore.mama|2|7h30 - 9h00')!},
        ${todayDate},
        'present',
        ${`${todayDate}T07:33:00.000Z`},
        3,
        ${roomByName.get('Salle A1')!},
        ${`${todayDate}T07:32:00.000Z`},
        ${`${todayDate}T09:05:00.000Z`},
        true,
        true,
        ${directorId},
        'QR scanne dans la mauvaise salle'
      )
    `);

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
        ${teacherByUsername.get('bamba.amin')!},
        ${scheduleByComposite.get('bamba.amin|1|13h30 - 15h00')!},
        ${todayDate},
        'present',
        ${`${todayDate}T13:31:00.000Z`},
        1,
        ${roomByName.get('Salle A2')!},
        ${`${todayDate}T13:30:00.000Z`},
        ${`${todayDate}T15:01:00.000Z`},
        true,
        true,
        ${directorId},
        'Mismatch pour test alerte dashboard'
      )
    `);

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
        ${teacherByUsername.get('yao.serg')!},
        ${scheduleByComposite.get('yao.serg|2|10h30 - 12h00')!},
        ${yesterday},
        'absent',
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        false,
        false,
        ${directorId},
        'Absence non justifiee'
      )
    `);
  });

  console.info('[seed] Seed completed successfully');
  console.info(`[seed] Tenant: ${TENANT.subdomain} (${TENANT.schemaName})`);
  console.info('[seed] Teacher login ready: diallo.ibra / edutrack2024');
};

void main().catch((error) => {
  console.error('[seed] Failed:', error);
  process.exitCode = 1;
});
