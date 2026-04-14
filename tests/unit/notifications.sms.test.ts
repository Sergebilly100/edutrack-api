import { describe, expect, it } from 'vitest';

import {
  buildStudentAbsentSms,
  buildTeacherLateSms,
  buildTeacherQrAlertSms,
  SMS_MAX_LENGTH,
} from '../../src/modules/notifications/notifications.sms.js';

describe('notifications.sms', () => {
  it('buildTeacherLateSms() produit le template attendu', () => {
    const sms = buildTeacherLateSms({
      teacherName: 'Yao Marie',
      lateMinutes: 12,
      subject: 'Mathématiques',
      className: '3ème A',
      slotLabel: '07h30-09h00',
      date: '2026-04-14',
    });

    expect(sms).toBe(
      'EduTrack: Yao Marie en retard de 12min - Mathématiques (3ème A, 07h30-09h00). 2026-04-14'
    );
    expect(sms.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
  });

  it('buildTeacherQrAlertSms() produit les 3 templates QR attendus', () => {
    const mismatch = buildTeacherQrAlertSms('teacher_qr_mismatch', {
      teacherName: 'Yao Marie',
      scannedRoom: 'Salle B2',
      expectedRoom: 'Salle A1',
      subject: 'SVT',
      slotLabel: '09h15-10h45',
    });

    const missing = buildTeacherQrAlertSms('teacher_qr_missing_scan', {
      teacherName: 'Yao Marie',
      subject: 'SVT',
      className: '4ème C',
      slotLabel: '09h15-10h45',
    });

    const outOfTime = buildTeacherQrAlertSms('teacher_qr_scan_out_of_time', {
      teacherName: 'Yao Marie',
      subject: 'SVT',
      date: '2026-04-14',
      slotLabel: '09h15-10h45',
    });

    expect(mismatch).toBe(
      'EduTrack: Yao Marie a scanné salle Salle B2 au lieu de Salle A1 - SVT 09h15-10h45'
    );
    expect(missing).toBe(
      "EduTrack: Yao Marie n'a pas scanné le QR de sa salle - SVT (4ème C) 09h15-10h45"
    );
    expect(outOfTime).toBe(
      'EduTrack: Scan QR hors horaire par Yao Marie - SVT 2026-04-14 09h15-10h45'
    );

    expect(mismatch.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
    expect(missing.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
    expect(outOfTime.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
  });

  it('garde les templates sous 160 caractères avec nom prof de 30 chars', () => {
    const teacherName = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234';
    expect(teacherName).toHaveLength(30);

    const late = buildTeacherLateSms({
      teacherName,
      lateMinutes: 12,
      subject: 'Mathématiques avancées',
      className: 'Terminale D1',
      slotLabel: '07h30-09h00',
      date: '2026-04-14',
    });

    const mismatch = buildTeacherQrAlertSms('teacher_qr_mismatch', {
      teacherName,
      scannedRoom: 'Salle Très Longue Alpha',
      expectedRoom: 'Salle Très Longue Bêta',
      subject: 'Mathématiques avancées',
      slotLabel: '07h30-09h00',
    });

    const missing = buildTeacherQrAlertSms('teacher_qr_missing_scan', {
      teacherName,
      subject: 'Mathématiques avancées',
      className: 'Terminale D1',
      slotLabel: '07h30-09h00',
    });

    const outOfTime = buildTeacherQrAlertSms('teacher_qr_scan_out_of_time', {
      teacherName,
      subject: 'Mathématiques avancées',
      date: '2026-04-14',
      slotLabel: '07h30-09h00',
    });

    expect(late.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
    expect(mismatch.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
    expect(missing.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
    expect(outOfTime.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
  });

  it('safeText fallback N/A si teacherName null', () => {
    const sms = buildTeacherLateSms({
      teacherName: null as unknown as string,
      lateMinutes: 5,
      subject: 'Maths',
      className: '3ème A',
      slotLabel: '07h30-09h00',
      date: '2026-04-14',
    });

    expect(sms).toContain('N/A');
  });

  it('buildStudentAbsentSms() produit le template attendu', () => {
    const sms = buildStudentAbsentSms({
      studentFirstName: 'Awa',
      subject: 'Mathématiques',
      date: '2026-04-14',
      schoolPhone: '2250700000001',
    });

    expect(sms).toBe(
      'EduTrack: Awa absent(e) en Mathématiques le 2026-04-14. Contact école: 2250700000001'
    );
    expect(sms.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
  });
});
