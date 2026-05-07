import { emit } from '../../shared/events/event-bus.js';
import type {
  StudentAbsentPayload,
  TeacherCheckedInPayload,
  TeacherLatePayload,
  TeacherQrAlertPayload,
  TeacherQrInvalidPayload,
} from '../../shared/events/events.types.js';

export const emitTeacherCheckedIn = (payload: TeacherCheckedInPayload): void => {
  emit('teacher.checked_in', payload);
};

export const emitTeacherLate = (payload: TeacherLatePayload): void => {
  emit('teacher.late', payload);
};

export const emitTeacherQrAlert = (payload: TeacherQrAlertPayload): void => {
  emit('teacher.qr_alert', payload);
};

export const emitTeacherQrInvalid = (payload: TeacherQrInvalidPayload): void => {
  emit('teacher.qr_invalid', payload);
};

export const emitStudentAbsent = (payload: StudentAbsentPayload): void => {
  emit('student.absent', payload);
};
