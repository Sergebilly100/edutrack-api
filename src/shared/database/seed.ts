import { createHash } from 'node:crypto';

import argon2 from 'argon2';
import { sql } from 'drizzle-orm';

import { db } from './db.js';
import { createTenantSchema } from './tenant-init.js';

const TENANT = {
  // Nom de l'école de démonstration affiché dans toute l'interface.
  name: "Collège Moderne d'Abidjan",
  // Le subdomain et le schemaName restent stables : ils servent de tenant par défaut
  // (AUTH_DEFAULT_TENANT_SCHEMA) dans le code et de cible aux suites E2E. On ne change
  // que l'identité visible (nom, élèves, profs, parents).
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

if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PROD_SEED !== 'true') {
  console.error('[seed] Refusing to run in production without ALLOW_PROD_SEED=true');
  process.exit(1);
}

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
type ParentSeedRow = { id: string };

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

// UUID déterministe (forme v4) dérivé d'un identifiant stable (email/téléphone).
// But : conserver les MÊMES ids entre deux exécutions du seed pour que les sessions
// déjà ouvertes (JWT dont le `sub` = user id) restent valides après un re-seed.
const deterministicUuid = (seed: string): string => {
  const hex = deterministicHex(`uuid:${seed}`, 32);
  const variant = ((parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
};

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
  const parentPwdHash4567 = await argon2.hash('4567');
  const parentPwdHash6543 = await argon2.hash('6543');
  const parentPwdHash3322 = await argon2.hash('3322');
  const subscriptionUnitPriceFcfa = 1000;
  let superAdminIdForSmsFeature: string | null = null;

  // Démo reproductible et NON destructive : on ne droppe pas le schéma. Les migrations
  // sont rejouées de façon idempotente (runTenantMigrations gère le cas 42P16 des vues
  // redéfinies), puis les données sont réinitialisées plus bas. Les lignes porteuses de
  // session (users, parents) reçoivent des UUID DÉTERMINISTES (voir deterministicUuid)
  // afin que re-seeder ne casse pas une session ouverte dans le navigateur.
  console.info('[seed] Creating/updating tenant schema and applying tenant migrations...');
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

  await db.execute(sql`
    DELETE FROM public.edutrack_commission_records
    WHERE tenant_id = ${tenantId}
  `);
  await db.execute(sql`
    DELETE FROM public.school_sms_features
    WHERE tenant_id = ${tenantId}
  `);

  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL search_path TO "${TENANT.schemaName}", public`));

    console.info('[seed] Resetting tenant data...');
    // The tenant schema gains new tables over time (for example payments and
    // import_history). A sequence of DELETE statements becomes fragile as soon
    // as one of them adds a foreign key to an existing seeded entity. CASCADE
    // lets PostgreSQL remove every dependent row in referentially safe order.
    await tx.execute(sql.raw(`
      TRUNCATE TABLE
        sms_usage_log,
        subscription_payments,
        parent_student_links,
        parent_subscriptions,
        parents,
        position_assignments,
        salary_records,
        admin_positions,
        documents,
        attendances_student,
        attendances_teacher,
        notifications_log,
        schedules,
        schedule_periods,
        payments,
        students,
        classes,
        teachers,
        users,
        rooms,
        time_slots
      CASCADE
    `));

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
      INSERT INTO users (id, role, name, phone, email, password_hash, is_active)
      VALUES (
        ${deterministicUuid(DIRECTOR_EMAIL)}::uuid,
        'director',
        ${"Directeur Collège Moderne d'Abidjan"},
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

    const staffUser = await tx.execute<IdRow>(sql`
      INSERT INTO users (id, role, name, phone, email, password_hash, is_active)
      VALUES (
        ${deterministicUuid('secretariat@sainte-marie.ci')}::uuid,
        'staff',
        ${"Secrétaire Collège Moderne d'Abidjan"},
        '+225070888888',
        'secretariat@sainte-marie.ci',
        ${teacherPasswordHash},
        true
      )
      RETURNING id
    `);

    const staffId = staffUser.rows[0]?.id;
    if (!staffId) {
      throw new Error('[seed] Failed to create staff user');
    }

    const superAdminUser = await tx.execute<IdRow>(sql`
      INSERT INTO users (id, role, name, phone, email, password_hash, is_active)
      VALUES (
        ${deterministicUuid(SUPER_ADMIN_EMAIL)}::uuid,
        'super_admin',
        'Super Admin IvoirEdu',
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
    superAdminIdForSmsFeature = superAdminId;

    console.info('[seed] Inserting teachers (vacataires) with stable check-in tokens...');
    for (const teacher of TEACHER_SEED) {
      const userResult = await tx.execute<IdRow>(sql`
        INSERT INTO users (id, role, name, phone, email, password_hash, is_active)
        VALUES (
          ${deterministicUuid(teacher.email)}::uuid,
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

    if (teachersResult.rows.length < 2) {
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
        ${staffId},
        ap.id,
        ${directorId}
      FROM admin_positions ap
      WHERE ap.name = 'Censeur'
      LIMIT 1
    `);

    // Utiliser le mois actuel et le mois précédent pour les salary_records
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const previousMonthStr = `${previousMonth.getFullYear()}-${String(previousMonth.getMonth() + 1).padStart(2, '0')}-01`;

    // Fiches de salaire pour TOUS les professeurs (et non plus seulement 2) afin que le
    // module Salaires de la démo soit complet et payable : chaque prof a une fiche
    // "pending" pour le mois en cours et une fiche "paid" pour le mois précédent.
    // hourly_rate provient de TEACHER_SEED (même ordre que teachersResult : created_at ASC).
    for (const [teacherIndex, teacherRow] of teachersResult.rows.entries()) {
      const seedTeacher = TEACHER_SEED[teacherIndex % TEACHER_SEED.length];
      const hourlyRate = seedTeacher.hourlyRate;
      // Heures déterministes mais variées d'un prof à l'autre.
      const plannedCurrent = 40 + ((teacherIndex * 2) % 9); // 40..48
      const doneCurrent = plannedCurrent - (2 + (teacherIndex % 3)); // quelques heures non faites
      const plannedPrev = 40 + ((teacherIndex * 3) % 8);
      const donePrev = plannedPrev - (teacherIndex % 2); // mois précédent quasi complet
      const totalCurrent = Math.round(doneCurrent * hourlyRate);
      const totalPrev = Math.round(donePrev * hourlyRate);

      await tx.execute(sql`
        INSERT INTO salary_records (
          teacher_id, period_month, hours_planned, hours_done, hourly_rate,
          total_fcfa, status, notes, paid_at, paid_by
        )
        VALUES
        (
          ${teacherRow.id}, ${currentMonth}, ${plannedCurrent}, ${doneCurrent}, ${hourlyRate},
          ${totalCurrent}, 'pending', 'Bilan mois en cours', NULL, NULL
        ),
        (
          ${teacherRow.id}, ${previousMonthStr}, ${plannedPrev}, ${donePrev}, ${hourlyRate},
          ${totalPrev}, 'paid', 'Règlement validé', NOW() - INTERVAL '7 days', ${directorId}
        )
      `);
    }

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

    if (studentsResult.rows.length < 4) {
      throw new Error('[seed] Not enough students to seed SMS subscriptions');
    }

    const parentOne = await tx.execute<ParentSeedRow>(sql`
      INSERT INTO parents (id, full_name, phone, email, password_hash, is_active)
      VALUES (
        ${deterministicUuid('parent:2250701234567')}::uuid,
        'Awa Kouame',
        '2250701234567',
        'awa.kouame.parent@example.ci',
        ${parentPwdHash4567},
        true
      )
      RETURNING id
    `);
    const parentTwo = await tx.execute<ParentSeedRow>(sql`
      INSERT INTO parents (id, full_name, phone, email, password_hash, is_active)
      VALUES (
        ${deterministicUuid('parent:2250709876543')}::uuid,
        'Koffi Diallo',
        '2250709876543',
        'koffi.diallo.parent@example.ci',
        ${parentPwdHash6543},
        true
      )
      RETURNING id
    `);
    const parentThree = await tx.execute<ParentSeedRow>(sql`
      INSERT INTO parents (id, full_name, phone, email, password_hash, is_active)
      VALUES (
        ${deterministicUuid('parent:2250701123322')}::uuid,
        'Mariam Yao',
        '2250701123322',
        'mariam.yao.parent@example.ci',
        ${parentPwdHash3322},
        true
      )
      RETURNING id
    `);

    const parentOneId = parentOne.rows[0]?.id;
    const parentTwoId = parentTwo.rows[0]?.id;
    const parentThreeId = parentThree.rows[0]?.id;
    if (!parentOneId || !parentTwoId || !parentThreeId) {
      throw new Error('[seed] Failed to create SMS parents');
    }

    const activeStartOne = formatDate(addDays(new Date(), -2));
    const activeEndOne = formatDate(addDays(new Date(activeStartOne), 30));
    const activeStartTwo = formatDate(addDays(new Date(), -10));
    const activeEndTwo = formatDate(addDays(new Date(activeStartTwo), 60));
    const expiredStart = formatDate(addDays(new Date(), -90));
    const expiredEnd = formatDate(addDays(new Date(), -10));

    const subOneStudentIds = [studentsResult.rows[0]!.id];
    const subTwoStudentIds = [studentsResult.rows[1]!.id, studentsResult.rows[2]!.id];
    const subExpiredStudentIds = [studentsResult.rows[3]!.id];

    const subOneTotal = subscriptionUnitPriceFcfa * subOneStudentIds.length * 1;
    const subTwoTotal = subscriptionUnitPriceFcfa * subTwoStudentIds.length * 2;
    const subExpiredTotal = subscriptionUnitPriceFcfa * subExpiredStudentIds.length * 1;

    const subOne = await tx.execute<IdRow>(sql`
      INSERT INTO parent_subscriptions (
        parent_id,
        unit_price_fcfa,
        student_count,
        total_amount_fcfa,
        duration_months,
        starts_at,
        ends_at,
        status,
        auto_renew_alert,
        renewed_count,
        created_by,
        created_at
      )
      VALUES (
        ${parentOneId},
        ${subscriptionUnitPriceFcfa},
        ${subOneStudentIds.length},
        ${subOneTotal},
        1,
        ${activeStartOne},
        ${activeEndOne},
        'active',
        false,
        0,
        ${directorId},
        ${activeStartOne}::timestamptz
      )
      RETURNING id
    `);

    const subTwo = await tx.execute<IdRow>(sql`
      INSERT INTO parent_subscriptions (
        parent_id,
        unit_price_fcfa,
        student_count,
        total_amount_fcfa,
        duration_months,
        starts_at,
        ends_at,
        status,
        auto_renew_alert,
        renewed_count,
        created_by,
        created_at
      )
      VALUES (
        ${parentTwoId},
        ${subscriptionUnitPriceFcfa},
        ${subTwoStudentIds.length},
        ${subTwoTotal},
        2,
        ${activeStartTwo},
        ${activeEndTwo},
        'active',
        true,
        0,
        ${staffId},
        ${activeStartTwo}::timestamptz
      )
      RETURNING id
    `);

    const subExpired = await tx.execute<IdRow>(sql`
      INSERT INTO parent_subscriptions (
        parent_id,
        unit_price_fcfa,
        student_count,
        total_amount_fcfa,
        duration_months,
        starts_at,
        ends_at,
        status,
        auto_renew_alert,
        renewed_count,
        created_by,
        created_at
      )
      VALUES (
        ${parentThreeId},
        ${subscriptionUnitPriceFcfa},
        ${subExpiredStudentIds.length},
        ${subExpiredTotal},
        1,
        ${expiredStart},
        ${expiredEnd},
        'expired',
        false,
        0,
        ${directorId},
        ${expiredStart}::timestamptz
      )
      RETURNING id
    `);

    const subOneId = subOne.rows[0]?.id;
    const subTwoId = subTwo.rows[0]?.id;
    const subExpiredId = subExpired.rows[0]?.id;
    if (!subOneId || !subTwoId || !subExpiredId) {
      throw new Error('[seed] Failed to create parent subscriptions');
    }

    for (const studentId of subOneStudentIds) {
      await tx.execute(sql`
        INSERT INTO parent_student_links (subscription_id, parent_id, student_id)
        VALUES (${subOneId}, ${parentOneId}, ${studentId})
      `);
    }
    for (const studentId of subTwoStudentIds) {
      await tx.execute(sql`
        INSERT INTO parent_student_links (subscription_id, parent_id, student_id)
        VALUES (${subTwoId}, ${parentTwoId}, ${studentId})
      `);
    }
    for (const studentId of subExpiredStudentIds) {
      await tx.execute(sql`
        INSERT INTO parent_student_links (subscription_id, parent_id, student_id)
        VALUES (${subExpiredId}, ${parentThreeId}, ${studentId})
      `);
    }

    await tx.execute(sql`
      INSERT INTO subscription_payments (subscription_id, amount_fcfa, payment_method, paid_at, recorded_by, notes)
      VALUES
      (${subOneId}, ${subOneTotal}, 'cash', ${activeStartOne}::timestamptz, ${staffId}, 'Paiement comptant souscription parent'),
      (${subTwoId}, ${subTwoTotal}, 'momo_mtn', ${activeStartTwo}::timestamptz, ${directorId}, 'Paiement MTN MoMo souscription parent'),
      (${subExpiredId}, ${subExpiredTotal}, 'cash', ${expiredStart}::timestamptz, ${directorId}, 'Paiement comptant souscription expirée')
    `);

    const currentMonthSms = formatDate(new Date()).slice(0, 7);
    await tx.execute(sql`
      INSERT INTO sms_usage_log (subscription_id, student_id, month, sms_sent_count, email_sent_count)
      VALUES
      (${subOneId}, ${subOneStudentIds[0]}, ${currentMonthSms}, 4, 1),
      (${subTwoId}, ${subTwoStudentIds[0]}, ${currentMonthSms}, 7, 3),
      (${subTwoId}, ${subTwoStudentIds[1]}, ${currentMonthSms}, 2, 1)
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

      await tx.execute(sql`
        UPDATE attendances_teacher
        SET
          geo_status = 'suspicious',
          checkin_distance = 147,
          actual_minutes = 60,
          checked_out_at = ${`${todayDate}T${addMinutesToTime(presentA.slot_start.slice(0, 5), 60)}:00.000Z`},
          validation_status = 'pending',
          validation_reason = 'Seed validation GPS suspect',
          validated_hours = NULL,
          validated_by = NULL,
          validated_at = NULL,
          note = 'Présence seed à valider: GPS suspect'
        WHERE teacher_id = ${presentA.teacher_id}
          AND schedule_id = ${presentA.id}
          AND date = ${todayDate}
      `);

      await tx.execute(sql`
        UPDATE attendances_teacher
        SET
          geo_status = 'verified',
          checkin_distance = 12,
          actual_minutes = 38,
          checked_out_at = ${`${todayDate}T${addMinutesToTime(presentB.slot_start.slice(0, 5), 38)}:00.000Z`},
          validation_status = 'pending',
          validation_reason = 'Seed validation heures courtes',
          validated_hours = NULL,
          validated_by = NULL,
          validated_at = NULL,
          note = 'Présence seed à valider: heures courtes'
        WHERE teacher_id = ${presentB.teacher_id}
          AND schedule_id = ${presentB.id}
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

  if (!superAdminIdForSmsFeature) {
    throw new Error('[seed] Missing super admin id for SMS feature seed');
  }

  const currentMonth = formatDate(new Date()).slice(0, 7);
  const currentPeriodMonth = `${currentMonth}-01`;

  await db.execute(sql`
    INSERT INTO public.school_sms_features (
      tenant_id,
      is_enabled,
      monetize_parent_alerts,
      commission_pct,
      sms_cap_per_student,
      sms_unit_price_fcfa,
      use_real_hours,
      geo_check_enabled,
      checkout_tolerance_minutes,
      activated_at,
      activated_by
    )
    VALUES (
      ${tenantId},
      true,
      -- La fonctionnalité SMS est activée (is_enabled) ET monétisée auprès des parents.
      -- monetize_parent_alerts pilote la visibilité des menus directeur "Abonnements" et
      -- "Revenus abonnements" (cf. Sidebar/BottomNav/MobileDrawer + route guard côté web) :
      -- sans ce flag à true, les données d'abonnement/paiement seedées plus haut seraient
      -- invisibles dans l'UI.
      true,
      15.00,
      60,
      1000,
      true,
      true,
      5,
      NOW(),
      ${superAdminIdForSmsFeature}
    )
    ON CONFLICT (tenant_id)
    DO UPDATE SET
      is_enabled = EXCLUDED.is_enabled,
      monetize_parent_alerts = EXCLUDED.monetize_parent_alerts,
      commission_pct = EXCLUDED.commission_pct,
      sms_cap_per_student = EXCLUDED.sms_cap_per_student,
      sms_unit_price_fcfa = EXCLUDED.sms_unit_price_fcfa,
      use_real_hours = EXCLUDED.use_real_hours,
      geo_check_enabled = EXCLUDED.geo_check_enabled,
      checkout_tolerance_minutes = EXCLUDED.checkout_tolerance_minutes,
      activated_at = EXCLUDED.activated_at,
      activated_by = EXCLUDED.activated_by,
      updated_at = NOW()
  `);

  await db.execute(sql`
    INSERT INTO public.edutrack_commission_records (
      tenant_id,
      period_month,
      total_subscriptions_fcfa,
      commission_pct,
      commission_due_fcfa,
      commission_paid_fcfa,
      notes
    )
    VALUES (
      ${tenantId},
      ${currentPeriodMonth},
      5000,
      15.00,
      750,
      300,
      'Seed SMS feature commission snapshot'
    )
    ON CONFLICT (tenant_id, period_month)
    DO UPDATE SET
      total_subscriptions_fcfa = EXCLUDED.total_subscriptions_fcfa,
      commission_pct = EXCLUDED.commission_pct,
      commission_due_fcfa = EXCLUDED.commission_due_fcfa,
      commission_paid_fcfa = EXCLUDED.commission_paid_fcfa,
      notes = EXCLUDED.notes,
      updated_at = NOW()
  `);

  console.info('[seed] Seed completed successfully');
  console.info(`[seed] École: ${TENANT.name}`);
  console.info(`[seed] Tenant: ${TENANT.subdomain} (${TENANT.schemaName})`);
  console.info(`[seed] Directeur: ${DIRECTOR_EMAIL} / ${DEFAULT_PASSWORD}`);
  console.info(`[seed] Secrétaire (staff): secretariat@sainte-marie.ci / ${DEFAULT_PASSWORD}`);
  console.info(`[seed] Professeur: kouadio.nguessan@sainte-marie.ci / ${DEFAULT_PASSWORD}`);
  console.info('[seed] Parent: +2250701234567 / 4567 (changement de mot de passe au 1er login)');
  console.info(
    `[seed] Super admin: ${SUPER_ADMIN_EMAIL} / ${DEFAULT_PASSWORD} (schema: ${TENANT.schemaName})`
  );
};

void main()
  .then(() => {
    // Le pool PG (db.ts) garde des connexions ouvertes (min: 4) qui maintiennent
    // l'event loop actif : sans sortie explicite, `npm run db:seed` ne se termine jamais.
    process.exit(0);
  })
  .catch((error) => {
    console.error('[seed] Failed:', error);
    process.exit(1);
  });
