import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { buildAcademicGradingService } from '../../../modules/academic/academic-grading.service.js';
import { buildConductService } from '../../../modules/conduct/conduct.service.js';
import { buildReportCardsService } from '../../../modules/report-cards/report-cards.service.js';
import { buildFinancialCacheService } from '../../../modules/finance/financial-cache.service.js';
import { buildRiskService } from '../../../modules/risk/risk.service.js';
import { DemoRepository } from './demo.repository.js';
import { shiftDate, type DemoCalendar } from './demo.config.js';

const subjects = ['Mathématiques', 'Français', 'Anglais', 'Histoire-Géographie', 'SVT', 'Physique-Chimie'];
const teacherNames = ['Koffi N’Guessan', 'Mariam Coulibaly', 'Éric Kouassi', 'Aminata Traoré', 'Yao Konan', 'Grâce Bamba'];
const usernames = ['nguessan.koff', 'coulibaly.mari', 'kouassi.eric', 'traore.amin', 'konan.yao', 'bamba.grac'];
const firstNames = ['Aya', 'Koffi', 'Aïcha', 'Yao', 'Fatou', 'Kevin', 'Nadia', 'Issa', 'Grâce', 'Moussa', 'Akissi', 'Jean', 'Awa', 'Serge', 'Mariam', 'Abel', 'Aminata', 'Franck', 'Adjoua', 'David', 'Fanta', 'Ibrahim', 'Estelle', 'Daniel'];
const lastNames = ['Koné', 'Kouamé', 'Bamba', 'Traoré', 'Kouassi', 'Soro', 'Diabaté', 'N’Dri', 'Yao', 'Coulibaly', 'N’Guessan', 'Ouattara'];
const slotStarts = ['07:30', '08:30', '09:45', '10:45', '14:00', '15:00'];
const slotEnds = ['08:30', '09:30', '10:45', '11:45', '15:00', '16:00'];

type DemoClass = { id: string; roomId: string; subjectIds: string[]; students: string[] };
type DemoTeacher = { id: string; userId: string };

async function seedFamilies(repo: DemoRepository, klass: DemoClass, classIndex: number, yearId: string,
  directorId: string, passwordHash: string, calendar: DemoCalendar) {
  for (let index = 0; index < 24; index++) {
    const number = classIndex * 24 + index;
    const phone = `225070000${String(number + 1).padStart(4, '0')}`;
    const lastName = lastNames[(index + classIndex * 3) % lastNames.length]!;
    const studentId = await repo.insert('students', {
      class_id: klass.id, first_name: firstNames[index]!, last_name: lastName,
      matricule: `DEMO-${String(number + 1).padStart(4, '0')}`,
      birth_date: `${Number(calendar.start.slice(0, 4)) - 12 - classIndex * 2}-02-${String(index + 1).padStart(2, '0')}`,
      parent_name: `Parent ${lastName}`, parent_phone: phone, parent_email: `parent${number + 1}@demo.example`,
      created_at: calendar.start,
      notes: index === 0 ? 'Baisse des résultats et absences récentes : entretien famille à prévoir.' : null,
    });
    klass.students.push(studentId);
    await repo.insert('enrollments', { student_id: studentId, class_id: klass.id, school_year_id: yearId,
      type: classIndex === 0 ? 'new_registration' : 're_registration', status: 'confirmed',
      confirmed_by_user_id: directorId, enrolled_at: calendar.start, created_at: calendar.start });
    const parentId = await repo.insert('parents', { full_name: `Parent ${lastName}`, phone,
      email: `parent${number + 1}@demo.example`, password_hash: passwordHash, must_change_password: false,
      access_sent_at: calendar.start, created_at: calendar.start });
    let subscriptionId: string | null = null;
    if (index % 3 !== 1) {
      subscriptionId = await repo.insert('parent_subscriptions', { parent_id: parentId, unit_price_fcfa: 9000,
        student_count: 1, total_amount_fcfa: 9000, duration_months: 10, starts_at: calendar.start,
        ends_at: calendar.end, status: 'active', created_by: directorId, created_at: calendar.start });
      await repo.insert('subscription_payments', { subscription_id: subscriptionId, amount_fcfa: 9000,
        payment_method: 'cash', paid_at: calendar.start, recorded_by: directorId, created_at: calendar.start });
    }
    await repo.insert('parent_student_links', { parent_id: parentId, student_id: studentId,
      subscription_id: subscriptionId, created_at: calendar.start });

    // Nine families per scenario across the three levels.
    const profile = index % 8;
    if (profile === 3) {
      await repo.insert('student_tuition_overrides', { student_id: studentId, school_year_id: yearId,
        discount_amount: 30000, reason: 'Remise sociale de rentrée accordée par la direction',
        granted_by_user_id: directorId, created_at: calendar.start });
      for (const [offset, amount] of [[-203, 90000], [-105, 180000], [15, 270000]]) {
        await repo.insert('student_tuition_schedule_steps', { student_id: studentId, school_year_id: yearId,
          due_date: shiftDate(calendar.today, offset!), cumulative_amount_expected: amount! });
      }
    }
    const instalments = profile === 0 ? [50000, 30000] : profile === 1 ? [100000, 50000]
      : profile === 2 ? [150000, 150000] : profile === 3 ? [90000, 90000]
      : profile === 4 ? [100000, 50000] : profile === 5 ? [100000, 70000, 30000]
      : [100000, 100000];
    for (const [paymentIndex, amount] of instalments.entries()) {
      const paidOn = shiftDate(calendar.today, [-201, -103, -5][paymentIndex]! + number % 3);
      await repo.insert('payments', { student_id: studentId, school_year_id: yearId, amount,
        method: (['cash', 'mobile_money', 'bank_transfer'] as const)[number % 3]!,
        source: 'cashier_manual', status: 'confirmed', confirmed_by_user_id: directorId,
        receipt_number: `DEMO-${number + 1}-${paymentIndex + 1}`, payment_date: paidOn, created_at: paidOn });
    }
    if (profile === 4) await repo.insert('payments', { student_id: studentId, school_year_id: yearId, amount: 50000,
      method: 'cash', source: 'cashier_manual', status: 'waived_by_school', confirmed_by_user_id: directorId,
      receipt_number: `DEMO-${number + 1}-TOL`, payment_date: shiftDate(calendar.today, -20),
      created_at: shiftDate(calendar.today, -20) });
  }
}

async function seedAcademicHistory(repo: DemoRepository, classes: DemoClass[], teachers: DemoTeacher[],
  periodIds: string[], directorId: string, calendar: DemoCalendar) {
  const academic = buildAcademicGradingService(repo.db);
  const conduct = buildConductService(repo.db);
  const cards = buildReportCardsService(repo.db);
  for (const [periodIndex, periodId] of periodIds.entries()) {
    for (const [classIndex, klass] of classes.entries()) {
      for (const [subjectIndex, subjectId] of klass.subjectIds.entries()) {
        if (periodIndex === 2 && subjectIndex > 2) continue;
        const teacher = teachers[subjectIndex]!;
        for (let assessment = 0; assessment < (periodIndex === 2 ? 1 : 2); assessment++) {
          const evaluation = await academic.createEvaluation({ classId: klass.id, subjectId, gradingPeriodId: periodId,
            type: 'scheduled', coefficient: assessment + 1,
            label: `${assessment === 0 ? 'Interrogation' : 'Devoir de synthèse'} — ${subjects[subjectIndex]}`,
            evaluationDate: shiftDate(calendar.periods[periodIndex]!.start, periodIndex === 2 ? subjectIndex + 2 : 28 + assessment * 35),
          }, teacher.userId);
          for (const [index, studentId] of klass.students.entries()) {
            // T3 French remains partly entered, as on a real early-term workspace.
            if (periodIndex === 2 && subjectIndex === 1 && index > 17) continue;
            const score = index === 0 ? [14, 10, 7][periodIndex]! + assessment
              : Math.min(19, 8 + ((index * 3 + subjectIndex + classIndex) % 10) + assessment * 0.5 + periodIndex * 0.25);
            await academic.upsertGrade(evaluation.evaluation.id, { studentId, score, maxScore: 20 }, teacher.userId);
          }
        }
        if (periodIndex < 2) {
          const scope = { classId: klass.id, subjectId, gradingPeriodId: periodId };
          await academic.updateCompletion({ ...scope, status: 'in_progress' }, teacher.userId);
          await academic.updateCompletion({ ...scope, status: 'completed' }, teacher.userId);
        }
      }
    }
    if (periodIndex < 2) {
      // Historical demo data is built through the real services: first enter
      // all notes, then open review for every class before generating cards.
      await repo.setPeriodReviewStart(periodId, shiftDate(calendar.today, -1));
      for (const [classIndex, klass] of classes.entries()) {
        for (const [subjectIndex] of klass.subjectIds.entries()) {
          const teacher = teachers[subjectIndex]!;
          for (const [index, studentId] of klass.students.entries()) {
            await conduct.submitTeacherConductInput({ student_id: studentId, grading_period_id: periodId,
              note: index === 0 ? 11 : 14 + index % 5,
              observation: index === 0 ? 'Assiduité et participation à améliorer.' : 'Attitude sérieuse, efforts réguliers.',
            }, { userId: teacher.userId });
          }
        }
        for (const [index, studentId] of klass.students.entries()) {
          await conduct.decideConductGrade({ student_id: studentId, grading_period_id: periodId,
            note: index === 0 ? 12 : 15 + index % 4,
          }, { userId: teachers[classIndex]!.userId, canFinalize: false });
        }
        await cards.generateForClass(klass.id, periodId);
        await cards.publishBulk(klass.id, periodId, directorId);
      }
      await repo.finalizePeriodCalendar(periodId, calendar.periods[periodIndex]!.reviewStart, calendar.periods[periodIndex]!.end);
      await repo.dateAcademicHistory(periodId, calendar.periods[periodIndex]!.end);
    }
  }
}

async function seedAttendance(repo: DemoRepository, classes: DemoClass[], teachers: DemoTeacher[],
  slotIds: string[], schedulePeriodId: string, calendar: DemoCalendar) {
  for (const [classIndex, klass] of classes.entries()) {
    for (let day = 1; day <= 5; day++) {
      for (let slot = 0; slot < slotIds.length; slot++) {
        const subjectIndex = (slot + classIndex + day) % subjects.length;
        const teacher = teachers[subjectIndex]!;
        const scheduleId = await repo.insert('schedules', { schedule_period_id: schedulePeriodId,
          teacher_id: teacher.id, class_id: klass.id, room_id: klass.roomId,
          time_slot_id: slotIds[slot]!, day_of_week: day, subject: subjects[subjectIndex]!,
          start_date: calendar.start, end_date: calendar.end, created_at: calendar.start });
        for (let offset = -42; offset < 0; offset++) {
          const date = shiftDate(calendar.today, offset);
          if (new Date(`${date}T12:00:00Z`).getUTCDay() !== day) continue;
          // Respect the break between T2 and T3.
          if (date > calendar.periods[1]!.end && date < calendar.periods[2]!.start) continue;
          const absent = subjectIndex === 0 && day <= 2 && offset >= -28;
          const late = !absent && (day + slot + classIndex) % 17 === 0;
          const pending = !absent && subjectIndex === 4 && offset >= -7 && day === 3;
          const start = `${date}T${slotStarts[slot]}:00Z`;
          const checkin = new Date(new Date(start).getTime() + (late ? 20 : 0) * 60_000).toISOString();
          const end = `${date}T${slotEnds[slot]}:00Z`;
          await repo.insert('attendances_teacher', { teacher_id: teacher.id, schedule_id: scheduleId, date,
            status: absent ? 'absent' : late ? 'late' : 'present', late_minutes: absent ? null : late ? 20 : 0,
            checked_in_at: absent ? null : checkin, checked_out_at: absent ? null : end,
            room_scanned_id: absent ? null : klass.roomId, room_scan_start_at: absent ? null : checkin,
            room_scan_end_at: absent ? null : end, actual_minutes: absent ? 0 : late ? 40 : 60,
            validation_status: pending ? 'pending' : 'not_required', geo_status: pending ? 'suspicious' : 'not_checked',
            validation_reason: pending ? 'Position à vérifier par la direction' : null, created_at: end,
          });
          if (absent) continue; // No fictitious roll call for a lesson that did not happen.
          for (const [index, studentId] of klass.students.entries()) {
            const studentAbsent = index === 0 && day <= 2 || index === 8 && day === 4 && offset > -21;
            const excused = index === 5 && day === 5 && offset < -28;
            await repo.insert('attendances_student', { student_id: studentId, schedule_id: scheduleId, date,
              status: excused ? 'excused' : studentAbsent ? 'absent' : 'present', marked_by: teacher.userId,
              excuse_reason: excused ? 'Rendez-vous médical signalé par la famille' : null,
              excused_by: excused ? teacher.userId : null, excused_at: excused ? end : null, created_at: end });
          }
        }
      }
    }
  }
}

export async function seedDemo(repo: DemoRepository, directorId: string, passwordHash: string, calendar: DemoCalendar) {
  const yearId = await repo.insert('school_years', { label: calendar.label, start_date: calendar.start,
    end_date: calendar.end, end_of_year_review_start_date: calendar.review, status: 'active',
    grading_period_type: 'trimester', created_at: calendar.start });
  const periodIds: string[] = [];
  for (const [index, period] of calendar.periods.entries()) periodIds.push(await repo.insert('grading_periods', {
    school_year_id: yearId, type: 'trimester', order_index: index + 1, label: period.label,
    start_date: period.start,
    review_start_date: index < 2 ? shiftDate(calendar.today, index + 1) : period.reviewStart,
    end_date: index < 2 ? calendar.end : period.end,
    created_at: calendar.start,
  }));
  const teachers: DemoTeacher[] = [];
  for (const [index, name] of teacherNames.entries()) {
    const userId = await repo.insert('users', { name, email: `${usernames[index]}@demo.example`,
      role: 'teacher', password_hash: passwordHash, created_at: calendar.start });
    const id = await repo.insert('teachers', { user_id: userId, username: usernames[index]!,
      type: index % 2 ? 'permanent' : 'vacataire', subjects: sql`ARRAY[${subjects[index]}]::text[]`,
      hourly_rate: index % 2 ? null : 3500, monthly_salary: index % 2 ? 180000 : null, created_at: calendar.start });
    teachers.push({ id, userId });
  }
  const classes: DemoClass[] = [];
  for (const [index, level] of ['6ème', '4ème', '3ème'].entries()) {
    const levelId = await repo.insert('levels', { name: level, order_index: index, is_exam_class: index === 2 });
    const roomId = await repo.insert('rooms', { name: `Salle ${index + 1}`, qr_token: randomBytes(32).toString('hex'), capacity: 35 });
    const id = await repo.insert('classes', { name: `${level} A`, level, level_id: levelId,
      school_year_id: yearId, student_count: 24, homeroom_teacher_id: teachers[index]!.id, created_at: calendar.start });
    const klass: DemoClass = { id, roomId, subjectIds: [], students: [] };
    for (const [subjectIndex, name] of subjects.entries()) {
      const subjectId = await repo.insert('subjects', { level_id: levelId, name, coefficient: [4, 4, 2, 2, 2, 3][subjectIndex]! });
      klass.subjectIds.push(subjectId);
      await repo.insert('teacher_subject_assignments', { teacher_id: teachers[subjectIndex]!.id, subject_id: subjectId, class_id: id });
    }
    const planId = await repo.insert('tuition_plans', { level_id: levelId, school_year_id: yearId, total_amount: 300000, currency: 'FCFA' });
    for (const [offset, amount] of [[-203, 100000], [-105, 200000], [15, 300000]]) {
      await repo.insert('tuition_schedule_steps', { tuition_plan_id: planId, due_date: shiftDate(calendar.today, offset!), cumulative_amount_expected: amount! });
    }
    await seedFamilies(repo, klass, index, yearId, directorId, passwordHash, calendar);
    classes.push(klass);
  }
  const slotIds: string[] = [];
  for (const [index, start] of slotStarts.entries()) slotIds.push(await repo.insert('time_slots', {
    label: `${start} - ${slotEnds[index]}`, start_time: start, end_time: slotEnds[index]!, sort_order: index,
  }));
  const schedulePeriodId = await repo.insert('schedule_periods', { name: 'Emploi du temps annuel',
    valid_from: calendar.start, valid_to: calendar.end, created_by: directorId, created_at: calendar.start });
  await seedAttendance(repo, classes, teachers, slotIds, schedulePeriodId, calendar);
  await seedAcademicHistory(repo, classes, teachers, periodIds, directorId, calendar);
  await buildFinancialCacheService(repo.db).recalcAll(yearId);
  await buildRiskService(repo.db).recalculateAll();
  return { yearId, teachers: usernames, parentActive: '2250700000001', parentUnsubscribed: '2250700000002' };
}
