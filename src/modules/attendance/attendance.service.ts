import type { Queue } from 'bullmq';
import {
  emitStudentAbsent,
  emitTeacherCheckedIn,
  emitTeacherCheckoutCompleted,
  emitTeacherLate,
  emitTeacherQrAlert,
  emitTeacherQrInvalid,
} from './attendance.events.js';
import { AttendanceRepository } from './attendance.repository.js';
import type { ActiveAttendanceItem, CheckInResult } from './attendance.types.js';
import {
  buildDeferredAbsentJobId,
  type DeferredStudentAbsentJobData,
  type NotificationJobData,
} from '../notifications/notifications.queue.js';
import { logger } from '../../shared/observability/logger.js';
import { calculateAttendanceStatus, validateRoomScan } from '../../shared/utils/attendance.js';
import { ATTENDANCE_STATUS, CHECKED_IN_VIA } from '../../shared/constants/index.js';
import { haversineDistance, type GeoStatus } from '../../shared/utils/geo.js';
import { scheduleQrMissingScanCheck } from '../../shared/queue/attendance-queue.js';
import {
  currentDateIso,
  dayOfWeekFromDate,
  monthBoundsFromDate as getMonthBounds,
  toIso,
  toSlotDateTime,
} from '../../shared/utils/date.js';

export class AttendanceModuleError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message);
    this.name = 'AttendanceModuleError';
  }
}

type ServiceContext = {
  schemaName: string;
  userId: string;
};

const DEFAULT_SCHOOL_PHONE = (() => {
  const phone = process.env.DEFAULT_SCHOOL_PHONE;
  if (!phone && process.env.NODE_ENV === 'production') {
    throw new Error('[attendance] DEFAULT_SCHOOL_PHONE env variable is required in production');
  }
  return phone ?? '0000000000';
})();

const resolveGeo = (input: {
  enabled: boolean;
  latitude?: number;
  longitude?: number;
  roomLatitude: number | null;
  roomLongitude: number | null;
  roomRadius: number;
}): { status: GeoStatus; distance: number | null } => {
  if (!input.enabled) {
    return { status: 'not_checked', distance: null };
  }

  if (input.latitude === undefined || input.longitude === undefined) {
    return { status: 'unavailable', distance: null };
  }

  if (input.roomLatitude === null || input.roomLongitude === null) {
    return { status: 'not_checked', distance: null };
  }

  const distance = haversineDistance(
    input.latitude,
    input.longitude,
    input.roomLatitude,
    input.roomLongitude
  );

  return {
    status: distance <= input.roomRadius ? 'verified' : 'suspicious',
    distance,
  };
};

// QUALITÉ FIX : monthBoundsFromDate déplacé vers shared/utils/date.ts
export const monthBoundsFromDate = getMonthBounds;

// Fenêtre d'acceptation d'un `client_timestamp` (action réelle vs heure de sync).
// On accepte jusqu'à 7 jours dans le passé pour couvrir un téléphone offline une
// journée entière ou un week-end, et 5 min dans le futur pour tolérer une horloge client
// légèrement désynchronisée.
const CLIENT_TIMESTAMP_MAX_PAST_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours
const CLIENT_TIMESTAMP_MAX_FUTURE_MS = 5 * 60 * 1000; // 5 min

// Retourne l'horodatage réel à utiliser pour l'action :
// - si le client a fourni `client_timestamp` ET qu'il est dans la fenêtre acceptée
//   → on l'utilise (cas du pointage offline rejoué après sync)
// - sinon → on prend l'heure serveur (comportement historique)
//
// Les rejets sont silencieux (fallback serveur) plutôt que des erreurs : la
// présence du prof importe plus qu'un timestamp pixel-perfect.
const resolveActualOccurredAt = (clientTimestamp: string | undefined): Date => {
  const serverNow = new Date();
  if (!clientTimestamp) {
    return serverNow;
  }

  const parsed = new Date(clientTimestamp);
  if (Number.isNaN(parsed.getTime())) {
    logger.warn({ clientTimestamp }, '[attendance] invalid client_timestamp, falling back to server time');
    return serverNow;
  }

  const drift = serverNow.getTime() - parsed.getTime();
  if (drift > CLIENT_TIMESTAMP_MAX_PAST_MS) {
    logger.warn(
      { clientTimestamp, driftMs: drift },
      '[attendance] client_timestamp too old, falling back to server time'
    );
    return serverNow;
  }
  if (drift < -CLIENT_TIMESTAMP_MAX_FUTURE_MS) {
    logger.warn(
      { clientTimestamp, driftMs: drift },
      '[attendance] client_timestamp in the future, falling back to server time'
    );
    return serverNow;
  }

  return parsed;
};

/** Grâce métier après la fin du cours pendant laquelle le prof peut soumettre ou synchroniser l'appel. */
const ROLLCALL_SUBMISSION_GRACE_AFTER_END_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours

/** Délai après la fin du cours avant d'envoyer les notifications SMS parents. */
const ABSENT_NOTIF_DELAY_AFTER_END_MS = 20 * 60 * 1000; // 20 minutes

export class AttendanceService {
  constructor(
    private readonly repository: AttendanceRepository,
    private readonly notifQueue?: Queue<NotificationJobData>
  ) {}

  async checkIn(
    input: {
      scheduleId: string;
      date?: string;
      latitude?: number;
      longitude?: number;
      accuracy?: number;
      clientTimestamp?: string;
    },
    context: ServiceContext
  ): Promise<CheckInResult> {
    const teacher = await this.repository.findTeacherByUserId(context.userId);
    if (!teacher) {
      throw new AttendanceModuleError('Teacher profile not found', 404, 'TEACHER_NOT_FOUND');
    }

    const schedule = await this.repository.findScheduleContextForTeacher(
      input.scheduleId,
      teacher.id
    );
    if (!schedule) {
      throw new AttendanceModuleError('Schedule not found', 404, 'SCHEDULE_NOT_FOUND');
    }

    const date = input.date ?? currentDateIso();
    // Si l'action vient d'une queue offline, `clientTimestamp` reflète l'heure
    // réelle du pointage et évite que le prof apparaisse en retard / absent
    // alors qu'il était présent à l'heure.
    const checkedInAt = resolveActualOccurredAt(input.clientTimestamp);
    const slotStart = toSlotDateTime(date, schedule.slotStartTime);
    const slotEnd = toSlotDateTime(date, schedule.slotEndTime);
    const status = calculateAttendanceStatus(checkedInAt, slotStart, slotEnd);
    const flags = await this.repository.getSchoolFeatureFlags(context.schemaName);
    const geo = resolveGeo({
      enabled: flags.geo_check_enabled,
      latitude: input.latitude,
      longitude: input.longitude,
      roomLatitude: schedule.plannedRoomLatitude,
      roomLongitude: schedule.plannedRoomLongitude,
      roomRadius: schedule.plannedRoomGeoRadius,
    });
    const validationStatus = geo.status === 'suspicious' ? 'pending' : 'not_required';

    await this.repository.upsertCheckIn({
      teacherId: teacher.id,
      scheduleId: schedule.scheduleId,
      date,
      status: status.status,
      lateMinutes: status.lateMinutes,
      checkedInAt: toIso(checkedInAt),
      checkinLatitude: flags.geo_check_enabled ? input.latitude ?? null : null,
      checkinLongitude: flags.geo_check_enabled ? input.longitude ?? null : null,
      checkinAccuracy: flags.geo_check_enabled ? input.accuracy ?? null : null,
      checkinDistance: geo.distance,
      geoStatus: geo.status,
      validationStatus,
    });

    if (status.status !== ATTENDANCE_STATUS.ABSENT) {
      try {
        // CRITIQUE FIX : Timeout de 5s pour éviter blocage si Redis down
        await Promise.race([
          scheduleQrMissingScanCheck({
            schemaName: context.schemaName,
            scheduleId: schedule.scheduleId,
            date,
            slotStartTimeUtc: schedule.slotStartTime,
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Redis queue timeout')), 5000)
          )
        ]);
      } catch (error) {
        // Ne pas bloquer le pointage si la queue Redis est indisponible.
        logger.error(
          { err: error instanceof Error ? error.message : String(error) },
          '[attendance] failed to schedule qr missing-scan check'
        );
      }
    }

    const commonPayload = {
      tenantId: context.schemaName,
      schemaName: context.schemaName,
      teacherId: teacher.id,
      scheduleId: schedule.scheduleId,
      date,
      checkedInAt: toIso(checkedInAt),
      checkedInVia: CHECKED_IN_VIA.APP,
    } as const;

    if (status.status === ATTENDANCE_STATUS.LATE) {
      emitTeacherLate({
        ...commonPayload,
        lateMinutes: status.lateMinutes ?? 0,
      });
    } else if (status.status === ATTENDANCE_STATUS.PRESENT) {
      emitTeacherCheckedIn(commonPayload);
    }

    return {
      status: status.status,
      lateMinutes: status.lateMinutes,
      checkedInAt: toIso(checkedInAt),
      geoStatus: geo.status,
    };
  }

  async checkOut(
    input: {
      scheduleId: string;
      date?: string;
      latitude?: number;
      longitude?: number;
      accuracy?: number;
      clientTimestamp?: string;
    },
    context: ServiceContext
  ): Promise<{ success: true; actualMinutes: number; geoStatus: GeoStatus }> {
    const teacher = await this.repository.findTeacherByUserId(context.userId);
    if (!teacher) {
      throw new AttendanceModuleError('Teacher profile not found', 404, 'TEACHER_NOT_FOUND');
    }

    const schedule = await this.repository.findScheduleContextForTeacher(
      input.scheduleId,
      teacher.id
    );
    if (!schedule) {
      throw new AttendanceModuleError('Schedule not found', 404, 'SCHEDULE_NOT_FOUND');
    }

    const date = input.date ?? currentDateIso();
    const existing = await this.repository.getTeacherAttendance({
      teacherId: teacher.id,
      scheduleId: schedule.scheduleId,
      date,
    });

    if (!existing?.checked_in_at) {
      throw new AttendanceModuleError('Check-in not found', 404, 'CHECKIN_NOT_FOUND');
    }

    if (existing.checked_out_at) {
      throw new AttendanceModuleError('Check-out already recorded', 409, 'CHECKOUT_ALREADY_RECORDED');
    }

    const flags = await this.repository.getSchoolFeatureFlags(context.schemaName);

    // Si la policy de l'école exige le scan QR de fin, le checkout API est bloqué
    // tant que room_scan_end_at n'est pas renseigné. Cela empêche de contourner
    // la contrainte UI en appelant directement l'API.
    if (flags.require_end_scan && !existing.room_scan_end_at) {
      throw new AttendanceModuleError(
        'End QR scan is required before check-out',
        422,
        'END_SCAN_REQUIRED'
      );
    }

    // Idem checkIn : on respecte l'heure réelle de fin de cours quand fournie
    // par un client offline, pour ne pas surévaluer la durée du cours.
    const checkedOutAt = resolveActualOccurredAt(input.clientTimestamp);
    const checkedInAt = new Date(existing.checked_in_at);
    const geo = resolveGeo({
      enabled: flags.geo_check_enabled,
      latitude: input.latitude,
      longitude: input.longitude,
      roomLatitude: schedule.plannedRoomLatitude,
      roomLongitude: schedule.plannedRoomLongitude,
      roomRadius: schedule.plannedRoomGeoRadius,
    });
    const slotStart = toSlotDateTime(date, schedule.slotStartTime);
    const slotEnd = toSlotDateTime(date, schedule.slotEndTime);
    const scheduleDurationMinutes = Math.max(
      0,
      Math.floor((slotEnd.getTime() - slotStart.getTime()) / 60000)
    );
    const fullHours = Math.round((scheduleDurationMinutes / 60) * 100) / 100;

    // `actual_minutes` alimente la paie (use_real_hours) : c'est la DURÉE RÉELLE DE
    // COURS, pas le temps brut jusqu'au scan. On borne donc le checkout à slotEnd -
    // un prof qui scanne sa fin bien après la fin du cours ne doit pas être payé
    // pour ce temps hors créneau.
    const checkedOutCapped = new Date(Math.min(checkedOutAt.getTime(), slotEnd.getTime()));
    const actualMinutes = Math.max(
      0,
      Math.floor((checkedOutCapped.getTime() - checkedInAt.getTime()) / 60000)
    );

    // Heures réellement effectuées = de l'heure de début du cours à l'heure de fin réelle.
    // Si le prof est arrivé en retard, on recalcule la durée depuis le début du créneau.
    // Règle : heure_effectuée = min(checkout, slotEnd) - slotStart
    // Si heure_effectuée >= scheduleDuration - tolerance → comptabilisé automatiquement
    const effectiveMinutes = Math.max(
      0,
      Math.floor((checkedOutCapped.getTime() - slotStart.getTime()) / 60000)
    );
    const needsValidation =
      flags.use_real_hours &&
      effectiveMinutes < scheduleDurationMinutes - flags.checkout_tolerance_minutes;
    const validationStatus = needsValidation ? 'pending' : 'not_required';
    const validatedHours =
      flags.use_real_hours && validationStatus === 'not_required' ? fullHours : null;

    await this.repository.checkOut({
      teacherId: teacher.id,
      scheduleId: schedule.scheduleId,
      date,
      checkedOutAtIso: toIso(checkedOutAt),
      actualMinutes,
      checkoutLatitude: flags.geo_check_enabled ? input.latitude ?? null : null,
      checkoutLongitude: flags.geo_check_enabled ? input.longitude ?? null : null,
      checkoutAccuracy: flags.geo_check_enabled ? input.accuracy ?? null : null,
      checkoutGeoStatus: geo.status,
      validationStatus,
      validatedHours,
    });

    const { monthStart, monthEnd } = monthBoundsFromDate(date);
    emitTeacherCheckoutCompleted({
      schemaName: context.schemaName,
      teacherId: teacher.id,
      monthStart,
      monthEnd,
    });

    return { success: true, actualMinutes, geoStatus: geo.status };
  }

  async qrScan(
    input: {
      qrToken: string;
      scanType: 'start' | 'end';
      scheduleId: string;
      date?: string;
      clientTimestamp?: string;
    },
    context: ServiceContext
  ): Promise<{
    valid: boolean;
    roomMismatch: boolean;
    alertType: 'teacher_qr_mismatch' | 'teacher_qr_scan_out_of_time' | null;
  }> {
    const teacher = await this.repository.findTeacherByUserId(context.userId);
    if (!teacher) {
      throw new AttendanceModuleError('Teacher profile not found', 404, 'TEACHER_NOT_FOUND');
    }

    const schedule = await this.repository.findScheduleContextForTeacher(
      input.scheduleId,
      teacher.id
    );
    if (!schedule) {
      throw new AttendanceModuleError('Schedule not found', 404, 'SCHEDULE_NOT_FOUND');
    }

    const date = input.date ?? currentDateIso();
    // Le scan QR offline doit refléter l'heure réelle du scan (validateRoomScan
    // utilise scanTime pour vérifier la fenêtre de tolérance autour du créneau).
    const scannedAt = resolveActualOccurredAt(input.clientTimestamp);

    const scannedRoom = await this.repository.findRoomByToken(input.qrToken);
    if (!scannedRoom) {
      await this.repository.logQrInvalidAlert({
        teacherId: teacher.id,
        teacherName: teacher.name,
        qrToken: input.qrToken,
        timestamp: toIso(scannedAt),
      });
      emitTeacherQrInvalid({
        tenantId: context.schemaName,
        schemaName: context.schemaName,
        teacherId: teacher.id,
        teacherName: teacher.name,
        qrToken: input.qrToken,
        timestamp: toIso(scannedAt),
      });
      throw new AttendanceModuleError(
        'QR code non reconnu pour cet établissement',
        400,
        'QR_NOT_IN_SCHOOL'
      );
    }

    // roomMismatch : la salle scannée correspond-elle à la salle prévue dans l'EDT ?
    // Cette valeur est indépendante du scan de début - elle reflète la conformité EDT.
    const plannedValidation = validateRoomScan({
      scannedRoomToken: input.qrToken,
      expectedRoomToken: schedule.plannedRoomToken,
      scheduleDate: date,
      slotStartTime: schedule.slotStartTime,
      slotEndTime: schedule.slotEndTime,
      scanTime: scannedAt,
    });
    const roomMismatch = !plannedValidation.valid;

    // Pour le scan de fin, la VALIDATION qui décide d'enregistrer la fin du cours
    // est la cohérence début↔fin : le prof doit scanner la même salle qu'au début
    // (même s'il fait cours hors de la salle prévue dans l'EDT - cas courant).
    // On compare UNIQUEMENT les tokens de salle (début vs fin), SANS la contrainte
    // de fenêtre horaire : un scan de fin se fait à la fin du créneau (voire un peu
    // après), donc appliquer la fenêtre temporelle bloquerait quasiment tous les
    // scans de fin. `roomMismatch` (vs EDT) ne sert qu'à l'info « salle correcte/
    // incorrecte » et à l'alerte directeur. Si aucun scan de début (skip), on
    // accepte (cas dégradé).
    let validation = plannedValidation;
    let endScanMismatch = false;
    if (input.scanType === 'end') {
      const startScanToken = await this.repository.getStartScanRoomToken({
        teacherId: teacher.id,
        scheduleId: schedule.scheduleId,
        date,
      });
      if (startScanToken) {
        endScanMismatch = input.qrToken !== startScanToken;
        validation = { valid: !endScanMismatch, alertType: validation.alertType };
      }
    }

    await this.repository.ensureAttendanceRecord({
      teacherId: teacher.id,
      scheduleId: schedule.scheduleId,
      date,
    });

    // Au scan de fin : `endScanMismatch` (cohérence début↔fin) décide d'écrire
    // room_scan_end_at. Au scan de début : `roomMismatch` (EDT) est conservé tel quel.
    await this.repository.recordQrScan({
      teacherId: teacher.id,
      scheduleId: schedule.scheduleId,
      date,
      scanType: input.scanType,
      scannedRoomId: scannedRoom?.id ?? null,
      roomMismatch,
      endScanMismatch,
      qrAlertSent: roomMismatch,
      scannedAtIso: toIso(scannedAt),
    });

    if (roomMismatch && plannedValidation.alertType) {
      emitTeacherQrAlert({
        tenantId: context.schemaName,
        schemaName: context.schemaName,
        teacherId: teacher.id,
        scheduleId: schedule.scheduleId,
        date,
        alertType: plannedValidation.alertType,
        roomMismatch: true,
      });
    }

    // Scan de fin de cours : forcer l'envoi immédiat des notifications différées
    if (input.scanType === 'end' && this.notifQueue) {
      const absentStudents = await this.repository.listAbsentStudentsForSchedule({
        scheduleId: schedule.scheduleId,
        date,
      });
      await Promise.allSettled(
        absentStudents.map(async (studentId) => {
          const jobId = buildDeferredAbsentJobId(
            context.schemaName,
            schedule.scheduleId,
            studentId,
            date
          );
          const job = await this.notifQueue!.getJob(jobId);
          if (job) {
            await job.changeDelay(0).catch(() => { /* job déjà parti ou terminé */ });
          }
        })
      );
    }

    return {
      valid: validation.valid,
      // Au scan de fin, le front utilise roomMismatch pour décider d'accepter le
      // QR : on renvoie l'incohérence début↔fin (endScanMismatch), pas l'écart EDT,
      // pour ne pas refuser à tort un cours fait dans une salle ≠ EDT mais cohérent.
      roomMismatch: input.scanType === 'end' ? endScanMismatch : roomMismatch,
      alertType: plannedValidation.alertType,
    };
  }

  async skipQrStep(
    input: {
      scanType: 'start' | 'end';
      scheduleId: string;
      date?: string;
      clientTimestamp?: string;
    },
    context: ServiceContext
  ): Promise<{ success: true }> {
    const isAllowed = await this.repository.isTeacherQrSkipAllowed(context.schemaName);
    if (!isAllowed) {
      throw new AttendanceModuleError(
        'QR skip is disabled by school settings',
        403,
        'QR_SKIP_DISABLED'
      );
    }

    const teacher = await this.repository.findTeacherByUserId(context.userId);
    if (!teacher) {
      throw new AttendanceModuleError('Teacher profile not found', 404, 'TEACHER_NOT_FOUND');
    }

    const schedule = await this.repository.findScheduleContextForTeacher(
      input.scheduleId,
      teacher.id
    );
    if (!schedule) {
      throw new AttendanceModuleError('Schedule not found', 404, 'SCHEDULE_NOT_FOUND');
    }

    const date = input.date ?? currentDateIso();
    const scannedAt = resolveActualOccurredAt(input.clientTimestamp);

    if (input.scanType === 'start') {
      const existing = await this.repository.getTeacherAttendance({
        teacherId: teacher.id,
        scheduleId: schedule.scheduleId,
        date,
      });

      if (!existing?.checked_in_at) {
        const slotStart = toSlotDateTime(date, schedule.slotStartTime);
        const slotEnd = toSlotDateTime(date, schedule.slotEndTime);
        const status = calculateAttendanceStatus(scannedAt, slotStart, slotEnd);

        await this.repository.upsertCheckIn({
          teacherId: teacher.id,
          scheduleId: schedule.scheduleId,
          date,
          status: status.status,
          lateMinutes: status.lateMinutes,
          checkedInAt: toIso(scannedAt),
        });
      }
    } else {
      await this.repository.ensureAttendanceRecord({
        teacherId: teacher.id,
        scheduleId: schedule.scheduleId,
        date,
      });
    }

    await this.repository.recordQrScan({
      teacherId: teacher.id,
      scheduleId: schedule.scheduleId,
      date,
      scanType: input.scanType,
      scannedRoomId: schedule.plannedRoomId,
      roomMismatch: false,
      qrAlertSent: false,
      scannedAtIso: toIso(scannedAt),
    });

    return { success: true };
  }

  async getActive(context: ServiceContext): Promise<{ date: string; items: ActiveAttendanceItem[] }> {
    const teacher = await this.repository.findTeacherByUserId(context.userId);
    if (!teacher) {
      throw new AttendanceModuleError('Teacher profile not found', 404, 'TEACHER_NOT_FOUND');
    }

    const now = new Date();
    const date = currentDateIso();
    const dayOfWeek = dayOfWeekFromDate(now);

    const items = await this.repository.listActiveAttendanceForTeacher({
      teacherId: teacher.id,
      date,
      dayOfWeek,
    });

    return { date, items };
  }

  // ── NOUVEAU - statuts de pointage pour une date (TeacherSchedulePage) ──────
  async getTeacherAttendanceByDate(
    input: { date: string },
    context: ServiceContext
  ): Promise<Array<{
    id: string;
    schedule_id: string;
    status: 'present' | 'absent' | 'late';
    late_minutes: number | null;
    date: string;
    room_scan_start_at: string | null;
    room_scan_end_at: string | null;
    checked_out_at: string | null;
    actual_minutes: number | null;
    geo_status: 'verified' | 'suspicious' | 'unavailable' | 'not_checked' | null;
  }>> {
    const teacher = await this.repository.findTeacherByUserId(context.userId);
    if (!teacher) {
      throw new AttendanceModuleError('Teacher profile not found', 404, 'TEACHER_NOT_FOUND');
    }

    return this.repository.getTeacherAttendanceByDate({
      teacherId: teacher.id,
      date: input.date,
    });
  }

  async getWeekScheduleForTeacher(
    userId: string,
    date: string,
  ): Promise<Array<{
    id: string;
    class_id: string;
    class_name: string;
    subject: string;
    room_id: string;
    room_name: string;
    day_of_week: number;
    start_time: string;
    end_time: string;
  }>> {
    const scheduleForWeek = await this.repository.getWeekScheduleForTeacher(userId, date);
    if (!scheduleForWeek) {
      throw new AttendanceModuleError('No schedule found for this week', 404, 'SCHEDULE_NOT_FOUND');
    }

    return scheduleForWeek;
  }

  private computeAfterSlotEndMs(date: string, slotEndTime: string, delayMs: number): number {
    // slotEndTime est au format "HH:MM", date au format "YYYY-MM-DD"
    const [hours, minutes] = slotEndTime.split(':').map(Number);
    
    const endOfClass = new Date(`${date}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`);
    return endOfClass.getTime() + delayMs;
  }

  // ── NOUVEAU - appel élèves par le prof ────────────────────────────────────
  async submitStudentAttendance(
    input: {
      scheduleId: string;
      date: string;
      absentStudentIds: string[];
      clientTimestamp?: string;
    },
    context: ServiceContext
  ): Promise<{ upsertedCount: number; notifSendAfter: number; isLocked: boolean }> {
    const teacher = await this.repository.findTeacherByUserId(context.userId);
    if (!teacher) {
      throw new AttendanceModuleError('Teacher profile not found', 404, 'TEACHER_NOT_FOUND');
    }

    // Vérifier que ce schedule appartient bien au prof
    const schedule = await this.repository.findScheduleContextForTeacher(
      input.scheduleId,
      teacher.id
    );
    if (!schedule) {
      throw new AttendanceModuleError('Schedule not found', 404, 'SCHEDULE_NOT_FOUND');
    }

    const rollcallDeadline = this.computeAfterSlotEndMs(
      input.date,
      schedule.slotEndTime,
      ROLLCALL_SUBMISSION_GRACE_AFTER_END_MS
    );
    const notifSendAfter = this.computeAfterSlotEndMs(
      input.date,
      schedule.slotEndTime,
      ABSENT_NOTIF_DELAY_AFTER_END_MS
    );

    // Pour la vérification de deadline, on utilise l'heure RÉELLE de l'action
    // (client_timestamp validé), pas l'heure de synchronisation.
    // Cas offline : si le prof a soumis l'appel pendant le cours (client_timestamp
    // dans la fenêtre), on accepte même si la sync arrive des heures plus tard.
    const actionTime = resolveActualOccurredAt(input.clientTimestamp);
    // const actionMs = actionTime.getTime();

    // Si actionTime === serverNow c'est soit pas de client_timestamp, soit un
    // timestamp trop vieux/invalide → on utilise l'heure serveur courante.
    // Dans le cas offline tardif avec client_timestamp valide, actionMs reflète
    // l'heure réelle du pointage, ce qui permet d'accepter une sync post-cours.

    if (actionTime.getTime() >= rollcallDeadline) {
      throw new AttendanceModuleError(
        'Rollcall submission window has closed',
        409,
        'ROLLCALL_WINDOW_CLOSED'
      );
    }

    // Récupérer la liste complète des élèves de la classe
    const allStudents = await this.repository.listStudentsByClass(schedule.classId ?? '');

    if (allStudents.length === 0) {
      return { upsertedCount: 0, notifSendAfter, isLocked: false };
    }

    const allStudentIds = allStudents.map((s) => s.id);
    const validatedAbsentIds = input.absentStudentIds.filter((id) => allStudentIds.includes(id));
    const validatedPresentIds = allStudentIds.filter((id) => !validatedAbsentIds.includes(id));

    const result = await this.repository.bulkUpsertStudentAttendance({
      scheduleId: input.scheduleId,
      date: input.date,
      absentStudentIds: validatedAbsentIds,
      markedByUserId: context.userId,
      allStudentIds,
    });

    // ── Gestion des jobs différés ──────────────────────────────────────────
    if (this.notifQueue) {
      // 1. Annuler les jobs différés des élèves qui sont désormais PRÉSENTS
      //    (peut arriver lors d'une re-soumission)
      await Promise.allSettled(
        validatedPresentIds.map((studentId) => {
          const jobId = buildDeferredAbsentJobId(
            context.schemaName,
            input.scheduleId,
            studentId,
            input.date
          );
          return this.notifQueue!.remove(jobId).catch(() => { /* job absent ou déjà parti */ });
        })
      );

      // 2. Enqueue les jobs différés pour les élèves ABSENTS (candidats à notif)
      const notificationCandidates =
        await this.repository.listStudentAbsenceNotificationCandidates({
          schemaName: context.schemaName,
          scheduleId: input.scheduleId,
          date: input.date,
          absentStudentIds: validatedAbsentIds,
        });

      const delayMs = Math.max(0, notifSendAfter - Date.now());

      await Promise.allSettled(
        notificationCandidates.map((student) => {
          const jobId = buildDeferredAbsentJobId(
            context.schemaName,
            input.scheduleId,
            student.studentId,
            input.date
          );
          const jobData: DeferredStudentAbsentJobData = {
            type: 'deferred-student-absent',
            schemaName: context.schemaName,
            tenantId: student.tenantId,
            studentId: student.studentId,
            scheduleId: input.scheduleId,
            studentFirstName: student.studentFirstName,
            parentPhone: student.parentPhone,
            parentEmail: student.parentEmail,
            subject: student.subject,
            date: input.date,
            schoolPhone: student.schoolPhone ?? DEFAULT_SCHOOL_PHONE,
          };
          // `add` avec jobId déterministe : si le job existe déjà (re-soumission),
          // BullMQ le met à jour (updateData) grâce à l'option `conflict: 'replace'`.
          // Pour les versions antérieures de BullMQ sans cette option, on remove + add.
          return this.notifQueue!.remove(jobId)
            .catch(() => { /* ignoré si job absent */ })
            .then(() =>
              this.notifQueue!.add('deferred-student-absent', jobData, {
                jobId,
                delay: delayMs,
                attempts: 3,
                backoff: { type: 'exponential', delay: 5_000 },
                removeOnComplete: true,
                removeOnFail: { count: 100 },
              })
            );
        })
      );
    } else {
      // Fallback sans queue : comportement synchrone immédiat (dev / tests)
      const notificationCandidates =
        await this.repository.listStudentAbsenceNotificationCandidates({
          schemaName: context.schemaName,
          scheduleId: input.scheduleId,
          date: input.date,
          absentStudentIds: validatedAbsentIds,
        });

      for (const student of notificationCandidates) {
        emitStudentAbsent({
          tenantId: student.tenantId,
          schemaName: context.schemaName,
          studentId: student.studentId,
          scheduleId: input.scheduleId,
          studentFirstName: student.studentFirstName,
          parentPhone: student.parentPhone,
          parentEmail: student.parentEmail,
          subject: student.subject,
          date: input.date,
          schoolPhone: student.schoolPhone ?? DEFAULT_SCHOOL_PHONE,
        });
      }
    }

    return { upsertedCount: result.upsertedCount, notifSendAfter, isLocked: false };
  }

  // Statuts de présence des élèves d'un cours pour un jour, pour pré-remplir
  // l'appel quand le prof le rouvre afin de corriger (élève absent → présent).
  async getStudentRollCall(
    input: { scheduleId: string; date: string },
    context: ServiceContext
  ): Promise<Array<{ student_id: string; status: 'present' | 'absent' | 'excused' | 'unmarked' }>> {
    const teacher = await this.repository.findTeacherByUserId(context.userId);
    if (!teacher) {
      throw new AttendanceModuleError('Teacher profile not found', 404, 'TEACHER_NOT_FOUND');
    }
    const schedule = await this.repository.findScheduleContextForTeacher(
      input.scheduleId,
      teacher.id
    );
    if (!schedule) {
      throw new AttendanceModuleError('Schedule not found', 404, 'SCHEDULE_NOT_FOUND');
    }
    return this.repository.listStudentRollCallForSchedule({
      classId: schedule.classId ?? '',
      scheduleId: schedule.scheduleId,
      date: input.date,
    });
  }

  async detectMissingQrScans(context: { schemaName: string; date?: string }): Promise<number> {
    const date = context.date ?? currentDateIso();
    const missing = await this.repository.listMissingQrScans({ date });

    for (const item of missing) {
      emitTeacherQrAlert({
        tenantId: context.schemaName,
        schemaName: context.schemaName,
        teacherId: item.teacherId,
        scheduleId: item.scheduleId,
        date,
        alertType: 'teacher_qr_missing_scan',
        roomMismatch: false,
      });

      await this.repository.markQrAlertSent({
        teacherId: item.teacherId,
        scheduleId: item.scheduleId,
        date,
      });
    }

    return missing.length;
  }

  async markMissingAttendancesAsAbsent(): Promise<number> {
    return this.repository.markMissingTeacherAttendancesAsAbsent();
  }

  async getTodayForDirector(): Promise<{
    date: string;
    present: number;
    absent: number;
    not_checked: number;
    present_count: number;
    absent_count: number;
    not_checked_count: number;
    unmarked_count: number;
    courses: Array<{
      schedule_id: string;
      teacher_name: string;
      subject: string;
      class: string;
      class_name: string;
      room_name: string;
      slot_label: string;
      start_time: string;
      end_time: string;
      status: 'present' | 'absent' | 'late' | 'not_checked';
      attendance_status: 'present' | 'absent' | 'late' | null;
      late_minutes: number | null;
      room_mismatch: boolean;
      room_scanned_name: string | null;
      room_scanned_at: string | null;
      room_scan_end_at: string | null;
      checked_in_at: string | null;
      student_rollcall_done: boolean;
      student_present_count: number;
      student_absent_count: number;
      student_total_count: number;
    }>;
  }> {
    const today = await this.repository.listTodayForDirector();
    return {
      date: today.date,
      present: today.presentCount,
      absent: today.absentCount,
      not_checked: today.unmarkedCount,
      present_count: today.presentCount,
      absent_count: today.absentCount,
      not_checked_count: today.unmarkedCount,
      unmarked_count: today.unmarkedCount,
      courses: today.courses.map((course) => ({
        ...course,
        class: course.class_name,
        status:
          course.attendance_status === null
            ? 'not_checked'
            : course.attendance_status,
        room_mismatch: course.room_mismatch ?? false,
      })),
    };
  }

  async getHistoryForDirector(days: number): Promise<
    Array<{
      date: string;
      present: number;
      absent: number;
      not_checked: number;
      present_count: number;
      absent_count: number;
      not_checked_count: number;
      total_count: number;
      attendance_rate: number;
    }>
  > {
    const rows = await this.repository.listHistoryForDirector(days);
    return rows.map((row) => ({
      ...row,
      present: row.present_count,
      absent: row.absent_count,
      not_checked: row.not_checked_count,
    }));
  }

  async exportTeacherHistory(input: {
    teacherId: string;
    from: string;
    to: string;
  }): Promise<
    Array<{
      date: string;
      schedule_id: string;
      teacher_name: string;
      subject: string;
      class_name: string;
      room_name: string;
      start_time: string;
      end_time: string;
      attendance_status: 'present' | 'absent' | 'late' | null;
      late_minutes: number | null;
      checked_in_at: string | null;
      room_mismatch: boolean;
      room_scanned_name: string | null;
      room_scanned_at: string | null;
      student_rollcall_done: boolean;
      student_present_count: number;
      student_absent_count: number;
      student_total_count: number;
    }>
  > {
    if (input.from > input.to) {
      throw new AttendanceModuleError('to must be >= from', 400, 'INVALID_DATE_RANGE');
    }
    return this.repository.listHistoryForTeacher({
      teacherId: input.teacherId,
      from: input.from,
      to: input.to,
    });
  }

  async getHistoryDetailForDirector(input: { from: string; to: string }): Promise<
    Array<{
      date: string;
      schedule_id: string;
      teacher_name: string;
      subject: string;
      class_name: string;
      room_name: string;
      start_time: string;
      end_time: string;
      attendance_status: 'present' | 'absent' | 'late' | null;
      late_minutes: number | null;
      checked_in_at: string | null;
      room_mismatch: boolean;
      room_scanned_name: string | null;
      room_scanned_at: string | null;
      student_rollcall_done: boolean;
      student_present_count: number;
      student_absent_count: number;
      student_total_count: number;
    }>
  > {
    if (input.from > input.to) {
      throw new AttendanceModuleError('to must be >= from', 400, 'INVALID_DATE_RANGE');
    }

    return this.repository.listHistoryDetailForDirector({
      from: input.from,
      to: input.to,
    });
  }

  // getTeacherCompliance retourne pour chaque enseignant le taux de conformité de ses pointages (check-in et check-out effectués, scans QR effectués quand requis, etc.) 
  // sur une période donnée. Utile pour identifier les enseignants qui auraient des difficultés à pointer correctement et leur apporter un accompagnement ciblé.
  async getTeacherCompliance(input: { month: string; role?: string; userId?: string }): Promise<
    Array<{
      teacherId: string;
      teacherName: string;
      totalCheckins: number;
      totalCheckouts: number;
      complianceRate: number;
      scanEndRate: number;
      roomCorrectRate: number;
      rollcallRate: number;
      attendanceRate: number;
      rank: number;
    }>
  > {
    const { monthStart, monthEnd } = monthBoundsFromDate(`${input.month}-01`);
    let teacherId: string | undefined;
    if (input.role === 'teacher') {
      if (!input.userId) {
        throw new AttendanceModuleError('Unauthorized', 401, 'UNAUTHORIZED');
      }
      const teacher = await this.repository.findTeacherByUserId(input.userId);
      if (!teacher) {
        throw new AttendanceModuleError('Teacher profile not found', 404, 'TEACHER_NOT_FOUND');
      }
      teacherId = teacher.id;
    }

    const rows = await this.repository.listTeacherCompliance({
      monthStart,
      monthEnd,
      teacherId,
    });
    return rows.map((row, index) => ({
      teacherId: row.teacher_id,
      teacherName: row.teacher_name,
      totalCheckins: Number(row.total_checkins),
      totalCheckouts: Number(row.total_checkouts),
      complianceRate: Number(row.compliance_rate), // taux de conformité global resultat du calcul prenant en compte tous les aspects du pointage (check-in, check-out, scans QR, etc.)
      scanEndRate: Number(row.scan_end_rate),
      roomCorrectRate: Number(row.room_correct_rate),
      rollcallRate: Number(row.rollcall_rate),
      attendanceRate: Number(row.attendance_rate), // taux de présence des cours (cours avec check-in ou check-out enregistré / cours totaux)
      rank: index + 1,
    }));
  }

  async getSuspiciousAttendances(input: { month: string }) {
    const { monthStart, monthEnd } = monthBoundsFromDate(`${input.month}-01`);
    return this.repository.listSuspiciousAttendances({ monthStart, monthEnd }).then((rows) =>
      rows.map((row) => ({
        attendanceId: row.attendance_id,
        teacherName: row.teacher_name,
        courseName: row.course_name,
        date: row.date,
        checkedInAt: row.checked_in_at,
        checkinDistance: row.checkin_distance === null ? null : Number(row.checkin_distance),
        checkinAccuracy: row.checkin_accuracy === null ? null : Number(row.checkin_accuracy),
      }))
    );
  }

  async reviewGeoAttendance(input: { attendanceId: string; decision: 'validated' | 'rejected' }) {
    await this.repository.reviewGeoAttendance(input);
    return { success: true };
  }
}

export const buildAttendanceService = (
  db: ConstructorParameters<typeof AttendanceRepository>[0],
  notifQueue?: Queue<NotificationJobData>
): AttendanceService => new AttendanceService(new AttendanceRepository(db), notifQueue);
