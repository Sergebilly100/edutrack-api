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

type DemoClass = { id: string; roomId: string; levelId: string; levelName: string; subjectIds: string[]; students: string[] };
type DemoTeacher = { id: string; userId: string };

const SMS_MONTHLY_PRICE_FCFA = 1000;

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
    const subscriptionScenario = index % 6;
    if (subscriptionScenario !== 1) {
      const subscription = subscriptionScenario === 2
        ? { status: 'active', durationMonths: 1, startsAt: shiftDate(calendar.today, -25), endsAt: shiftDate(calendar.today, 5), autoRenewAlert: true }
        : subscriptionScenario === 3
          ? { status: 'expired', durationMonths: 1, startsAt: shiftDate(calendar.today, -34), endsAt: shiftDate(calendar.today, -4), autoRenewAlert: false }
          : subscriptionScenario === 4
            ? { status: 'cancelled', durationMonths: 3, startsAt: shiftDate(calendar.today, -10), endsAt: calendar.end, autoRenewAlert: false }
            : { status: 'active', durationMonths: 3, startsAt: calendar.periods[2]!.start, endsAt: calendar.end, autoRenewAlert: false };
      const totalAmount = SMS_MONTHLY_PRICE_FCFA * subscription.durationMonths;
      subscriptionId = await repo.insert('parent_subscriptions', { parent_id: parentId, unit_price_fcfa: SMS_MONTHLY_PRICE_FCFA,
        student_count: 1, total_amount_fcfa: totalAmount, duration_months: subscription.durationMonths, starts_at: subscription.startsAt,
        ends_at: subscription.endsAt, status: subscription.status, auto_renew_alert: subscription.autoRenewAlert,
        created_by: directorId, created_at: subscription.startsAt });
      if (subscription.status !== 'cancelled') await repo.insert('subscription_payments', { subscription_id: subscriptionId, amount_fcfa: totalAmount,
        payment_method: subscriptionScenario === 2 ? 'momo_mtn' : 'cash', paid_at: subscription.startsAt,
        recorded_by: directorId, created_at: subscription.startsAt });
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
        if (periodIndex === 2 && subjectIndex > 3) continue;
        const teacher = teachers[subjectIndex]!;
        for (let assessment = 0; assessment < (periodIndex === 2 ? 1 : 2); assessment++) {
          const t3Evaluation = periodIndex === 2
            ? subjectIndex === 0
              ? { label: 'Interrogation de reprise', date: shiftDate(calendar.periods[2]!.start, 4), gradedStudents: klass.students.length }
              : subjectIndex === 1
                ? { label: 'Contrôle de lecture', date: shiftDate(calendar.today, -1), gradedStudents: 16 }
                : { label: 'Évaluation programmée', date: shiftDate(calendar.today, subjectIndex === 2 ? 4 : 9), gradedStudents: 0 }
            : null;
          const evaluation = await academic.createEvaluation({ classId: klass.id, subjectId, gradingPeriodId: periodId,
            type: 'scheduled', coefficient: assessment + 1,
            label: `${t3Evaluation?.label ?? (assessment === 0 ? 'Interrogation' : 'Devoir de synthèse')} - ${subjects[subjectIndex]}`,
            evaluationDate: t3Evaluation?.date ?? shiftDate(calendar.periods[periodIndex]!.start, 28 + assessment * 35),
          }, teacher.userId);
          for (const [index, studentId] of klass.students.entries()) {
            if (periodIndex === 2 && index >= (t3Evaluation?.gradedStudents ?? 0)) continue;
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

async function seedArchivedSchoolRecords(repo: DemoRepository, currentClasses: DemoClass[], teachers: DemoTeacher[],
  directorId: string, calendar: DemoCalendar) {
  const archiveStart = shiftDate(calendar.start, -280);
  const archiveEnd = shiftDate(calendar.start, -1);
  const archiveStartYear = Number(archiveStart.slice(0, 4));
  const archiveLabel = `${archiveStartYear}-${archiveStartYear + 1}`;
  const importedHistoryLabel = `${archiveStartYear - 1}-${archiveStartYear}`;
  const archiveYearId = await repo.insert('school_years', {
    label: archiveLabel, start_date: archiveStart, end_date: archiveEnd,
    end_of_year_review_start_date: shiftDate(archiveEnd, -30), status: 'closed', grading_period_type: 'trimester', created_at: archiveStart,
  });
  const archivePeriods = [
    { label: 'Trimestre 1', start: archiveStart, reviewStart: shiftDate(archiveStart, 92), end: shiftDate(archiveStart, 107) },
    { label: 'Trimestre 2', start: shiftDate(archiveStart, 92), reviewStart: shiftDate(archiveStart, 184), end: shiftDate(archiveStart, 199) },
    { label: 'Trimestre 3', start: shiftDate(archiveStart, 184), reviewStart: shiftDate(archiveEnd, -30), end: archiveEnd },
  ];
  const archivePeriodIds = await Promise.all(archivePeriods.map((period, index) => repo.insert('grading_periods', {
    school_year_id: archiveYearId, type: 'trimester', order_index: index + 1, label: period.label,
    // Le seed rejoue les opérations métier à la date courante, puis remet les
    // dates historiques une fois les bulletins publiés.
    start_date: period.start, review_start_date: shiftDate(calendar.today, index + 1), end_date: shiftDate(calendar.today, index + 2), created_at: period.start,
  })));
  const archiveClasses: DemoClass[] = [];

  for (const [classIndex, currentClass] of currentClasses.entries()) {
    const students = currentClass.students.slice(0, 2);
    const archiveClassId = await repo.insert('classes', {
      name: `${currentClass.levelName} A - archive`, level: currentClass.levelName, level_id: currentClass.levelId,
      school_year_id: archiveYearId, student_count: students.length, homeroom_teacher_id: teachers[classIndex]!.id, created_at: archiveStart,
    });
    const archiveClass: DemoClass = {
      id: archiveClassId, roomId: currentClass.roomId, levelId: currentClass.levelId, levelName: currentClass.levelName,
      subjectIds: currentClass.subjectIds, students,
    };
    archiveClasses.push(archiveClass);
    for (const studentId of students) await repo.insert('enrollments', {
      student_id: studentId, class_id: archiveClassId, school_year_id: archiveYearId, type: 're_registration', status: 'confirmed',
      confirmed_by_user_id: directorId, enrolled_at: archiveStart, created_at: archiveStart,
    });
    for (const [subjectIndex, subjectId] of archiveClass.subjectIds.entries()) {
      await repo.insert('teacher_subject_assignments', { teacher_id: teachers[subjectIndex]!.id, subject_id: subjectId, class_id: archiveClassId });
    }
  }

  const academic = buildAcademicGradingService(repo.db);
  const conduct = buildConductService(repo.db);
  const cards = buildReportCardsService(repo.db);
  for (const [periodIndex, periodId] of archivePeriodIds.entries()) {
    for (const [classIndex, klass] of archiveClasses.entries()) {
      for (const [subjectIndex, subjectId] of klass.subjectIds.entries()) {
        const teacher = teachers[subjectIndex]!;
        const evaluation = await academic.createEvaluation({
          classId: klass.id, subjectId, gradingPeriodId: periodId, type: 'scheduled', coefficient: 1,
          label: `Devoir archivé - ${subjects[subjectIndex]}`, evaluationDate: shiftDate(archivePeriods[periodIndex]!.start, 24 + subjectIndex * 4),
        }, teacher.userId);
        for (const [studentIndex, studentId] of klass.students.entries()) {
          const score = Math.min(18, 9 + subjectIndex + periodIndex + classIndex + studentIndex * 2);
          await academic.upsertGrade(evaluation.evaluation.id, { studentId, score, maxScore: 20 }, teacher.userId);
        }
        await academic.updateCompletion({ classId: klass.id, subjectId, gradingPeriodId: periodId, status: 'in_progress' }, teacher.userId);
        await academic.updateCompletion({ classId: klass.id, subjectId, gradingPeriodId: periodId, status: 'completed' }, teacher.userId);
      }
    }
    await repo.setPeriodReviewStart(periodId, shiftDate(calendar.today, -1));
    for (const [classIndex, klass] of archiveClasses.entries()) {
      for (const [subjectIndex] of klass.subjectIds.entries()) {
        const teacher = teachers[subjectIndex]!;
        for (const [studentIndex, studentId] of klass.students.entries()) {
          await conduct.submitTeacherConductInput({ student_id: studentId, grading_period_id: periodId,
            note: 13 + ((studentIndex + subjectIndex + periodIndex) % 6), observation: 'Avis archivé de la période.',
          }, { userId: teacher.userId });
        }
      }
      for (const [studentIndex, studentId] of klass.students.entries()) {
        await conduct.decideConductGrade({ student_id: studentId, grading_period_id: periodId, note: 14 + ((studentIndex + periodIndex) % 4) },
          { userId: teachers[classIndex]!.userId, canFinalize: false });
      }
      await cards.generateForClass(klass.id, periodId);
      await cards.publishBulk(klass.id, periodId, directorId);
    }
    await repo.finalizePeriodCalendar(periodId, archivePeriods[periodIndex]!.reviewStart, archivePeriods[periodIndex]!.end);
    await repo.dateAcademicHistory(periodId, archivePeriods[periodIndex]!.end);
  }

  const importHistoryId = await repo.insert('import_history', {
    import_type: 'students', imported_count: 0, updated_count: archiveClasses.flatMap((klass) => klass.students).length,
    imported_by: directorId, imported_by_role: 'director', historical_school_year_label: importedHistoryLabel, imported_at: archiveEnd,
  });
  for (const klass of archiveClasses) {
    for (const studentId of klass.students) await repo.insert('student_historical_sources', {
      student_id: studentId, school_year_label: importedHistoryLabel, old_class_name: `${klass.levelName} B`,
      row_key: randomBytes(32).toString('hex'), import_history_id: importHistoryId, imported_at: archiveEnd,
    });
  }
  await repo.archiveClasses(archiveClasses.map((klass) => klass.id));
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
    const klass: DemoClass = { id, roomId, levelId, levelName: level, subjectIds: [], students: [] };
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
  await seedArchivedSchoolRecords(repo, classes, teachers, directorId, calendar);
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
  return {
    yearId, teachers: usernames, parentActive: '2250700000001', parentNearExpiry: '2250700000003',
    parentUnsubscribed: '2250700000002', archivedStudentsPerClass: 2,
  };
}
