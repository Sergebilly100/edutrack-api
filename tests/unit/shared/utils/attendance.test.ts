import { describe, expect, it } from 'vitest';

import {
  calculateAttendanceStatus,
  validateRoomScan,
} from '../../../../src/shared/utils/attendance.js';

describe('shared/utils/attendance', () => {
  it('check-in a H+8min -> present, lateMinutes=8', () => {
    const slotStart = new Date('2026-04-14T07:30:00.000Z');
    const slotEnd = new Date('2026-04-14T09:00:00.000Z');
    const checkedInAt = new Date('2026-04-14T07:38:00.000Z');

    const result = calculateAttendanceStatus(checkedInAt, slotStart, slotEnd);

    expect(result).toEqual({ status: 'present', lateMinutes: 8 });
  });

  it('check-in a H+20min -> late, lateMinutes=20', () => {
    const slotStart = new Date('2026-04-14T07:30:00.000Z');
    const slotEnd = new Date('2026-04-14T09:00:00.000Z');
    const checkedInAt = new Date('2026-04-14T07:50:00.000Z');

    const result = calculateAttendanceStatus(checkedInAt, slotStart, slotEnd);

    expect(result).toEqual({ status: 'late', lateMinutes: 20 });
  });

  it('checkedInAt = null -> absent + lateMinutes null', () => {
    const slotStart = new Date('2026-04-14T07:30:00.000Z');
    const slotEnd = new Date('2026-04-14T09:00:00.000Z');

    const result = calculateAttendanceStatus(null, slotStart, slotEnd);

    expect(result).toEqual({ status: 'absent', lateMinutes: null });
  });

  it('checkedInAt > slotEnd -> absent + lateMinutes null', () => {
    const slotStart = new Date('2026-04-14T07:30:00.000Z');
    const slotEnd = new Date('2026-04-14T09:00:00.000Z');
    const checkedInAt = new Date('2026-04-14T09:00:01.000Z');

    const result = calculateAttendanceStatus(checkedInAt, slotStart, slotEnd);

    expect(result).toEqual({ status: 'absent', lateMinutes: null });
  });

  it('checkedInAt = slotStart -> present + lateMinutes 0', () => {
    const slotStart = new Date('2026-04-14T07:30:00.000Z');
    const slotEnd = new Date('2026-04-14T09:00:00.000Z');

    const result = calculateAttendanceStatus(slotStart, slotStart, slotEnd);

    expect(result).toEqual({ status: 'present', lateMinutes: 0 });
  });

  it('checkedInAt = slotStart + 15min -> present + lateMinutes 15', () => {
    const slotStart = new Date('2026-04-14T07:30:00.000Z');
    const slotEnd = new Date('2026-04-14T09:00:00.000Z');
    const checkedInAt = new Date('2026-04-14T07:45:00.000Z');

    const result = calculateAttendanceStatus(checkedInAt, slotStart, slotEnd);

    expect(result).toEqual({ status: 'present', lateMinutes: 15 });
  });

  it('checkedInAt = slotStart + 16min -> late + lateMinutes 16', () => {
    const slotStart = new Date('2026-04-14T07:30:00.000Z');
    const slotEnd = new Date('2026-04-14T09:00:00.000Z');
    const checkedInAt = new Date('2026-04-14T07:46:00.000Z');

    const result = calculateAttendanceStatus(checkedInAt, slotStart, slotEnd);

    expect(result).toEqual({ status: 'late', lateMinutes: 16 });
  });

  it('scan QR mauvaise salle -> invalid + teacher_qr_mismatch', () => {
    const result = validateRoomScan({
      scannedRoomToken: 'room-token-wrong',
      expectedRoomToken: 'room-token-expected',
      scheduleDate: '2026-04-14',
      slotStartTime: '07:30:00',
      slotEndTime: '09:00:00',
      scanTime: new Date('2026-04-14T07:35:00.000Z'),
    });

    expect(result).toEqual({
      valid: false,
      alertType: 'teacher_qr_mismatch',
    });
  });

  it('validateRoomScan: scanTime < windowOpen -> out_of_time', () => {
    const result = validateRoomScan({
      scannedRoomToken: 'room-token-expected',
      expectedRoomToken: 'room-token-expected',
      scheduleDate: '2026-04-14',
      slotStartTime: '07:30:00',
      slotEndTime: '09:00:00',
      scanTime: new Date('2026-04-14T07:19:59.000Z'),
    });

    expect(result).toEqual({ valid: false, alertType: 'teacher_qr_scan_out_of_time' });
  });

  it('validateRoomScan: scanTime > slotEnd -> out_of_time', () => {
    const result = validateRoomScan({
      scannedRoomToken: 'room-token-expected',
      expectedRoomToken: 'room-token-expected',
      scheduleDate: '2026-04-14',
      slotStartTime: '07:30:00',
      slotEndTime: '09:00:00',
      scanTime: new Date('2026-04-14T09:00:01.000Z'),
    });

    expect(result).toEqual({ valid: false, alertType: 'teacher_qr_scan_out_of_time' });
  });

  it('validateRoomScan: bonne salle dans la fenetre -> valid', () => {
    const result = validateRoomScan({
      scannedRoomToken: 'room-token-expected',
      expectedRoomToken: 'room-token-expected',
      scheduleDate: '2026-04-14',
      slotStartTime: '07:30:00',
      slotEndTime: '09:00:00',
      scanTime: new Date('2026-04-14T07:20:00.000Z'),
    });

    expect(result).toEqual({ valid: true, alertType: null });
  });
});
