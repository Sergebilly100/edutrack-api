import type { AttendanceStatus } from '../types/index.js';
import { ATTENDANCE_STATUS, NOTIFICATION_TYPE } from '../constants/index.js';

export type AttendanceStatusResult = {
  status: AttendanceStatus;
  lateMinutes: number | null;
};

export type RoomScanValidationInput = {
  scannedRoomToken: string;
  expectedRoomToken: string;
  scheduleDate: string;
  slotStartTime: string;
  slotEndTime: string;
  scanTime: Date;
};

export type RoomScanAlertType =
  | typeof NOTIFICATION_TYPE.TEACHER_QR_MISMATCH
  | typeof NOTIFICATION_TYPE.TEACHER_QR_SCAN_OUT_OF_TIME;

export type RoomScanValidationResult = {
  valid: boolean;
  alertType: RoomScanAlertType | null;
};

// Cette fonction convertit une date et une heure au format string en un objet Date en UTC, en supposant que les strings d'entrée sont au format "YYYY-MM-DD" pour la date et "HH:mm" pour l'heure. 
// Cela permet de comparer correctement les horaires de cours et les heures de scan du QR code, indépendamment du fuseau horaire du serveur ou du client.
const toUtcDateTime = (date: string, time: string): Date => {
  return new Date(`${date}T${time}.000Z`);
};

// Cette fonction calcule le statut de présence d'un pointage en fonction de l'heure de scan du QR code par rapport aux horaires du cours, en tenant compte d'une tolérance de 15 minutes pour les retards.
export const calculateAttendanceStatus = (
  checkedInAt: Date | null,
  slotStart: Date,
  slotEnd: Date
): AttendanceStatusResult => {
  if (!checkedInAt || checkedInAt > slotEnd) {
    return { status: ATTENDANCE_STATUS.ABSENT, lateMinutes: null };
  }

  const diffMinutes = Math.floor((checkedInAt.getTime() - slotStart.getTime()) / 60000);

  if (diffMinutes <= 15) {
    return { status: ATTENDANCE_STATUS.PRESENT, lateMinutes: Math.max(0, diffMinutes) };
  }

  return { status: ATTENDANCE_STATUS.LATE, lateMinutes: diffMinutes };
};

// Cette fonction valide un scan de QR code de pointage en vérifiant que le token scanné correspond au token attendu pour la salle de cours, et que le scan a été effectué dans la fenêtre temporelle autorisée (10 minutes avant le début du cours jusqu'à la fin du cours). Elle retourne un résultat indiquant si le scan est valide ou non, et le type d'alerte à déclencher en cas de scan invalide (scan hors fenêtre temporelle ou token de salle incorrect).
export const validateRoomScan = (
  input: RoomScanValidationInput
): RoomScanValidationResult => {
  const slotStart = toUtcDateTime(input.scheduleDate, input.slotStartTime);
  const slotEnd = toUtcDateTime(input.scheduleDate, input.slotEndTime);
  const windowOpen = new Date(slotStart.getTime() - 10 * 60000);

  if (input.scanTime < windowOpen || input.scanTime > slotEnd) {
    return { valid: false, alertType: NOTIFICATION_TYPE.TEACHER_QR_SCAN_OUT_OF_TIME };
  }

  if (input.scannedRoomToken !== input.expectedRoomToken) {
    return { valid: false, alertType: NOTIFICATION_TYPE.TEACHER_QR_MISMATCH };
  }

  return { valid: true, alertType: null };
};
