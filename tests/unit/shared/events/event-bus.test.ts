import { describe, expect, it, vi } from 'vitest';

import { emit, off, on } from '../../../../src/shared/events/event-bus.js';
import type { EventMap } from '../../../../src/shared/events/events.types.js';

describe('EventBus', () => {
  it('delivers typed payload for teacher.absent', () => {
    const payload: EventMap['teacher.absent'] = {
      tenantId: 'tenant-1',
      schemaName: 'ecole_demo',
      teacherId: 'teacher-1',
      teacherName: 'Kouame Serge',
      subject: 'Mathematiques',
      className: 'CM2 A',
      slotLabel: '08:00-09:00',
      directorPhone: '+2250102030405',
    };

    const handler = vi.fn<(input: EventMap['teacher.absent']) => void>();

    on('teacher.absent', handler);
    emit('teacher.absent', payload);
    off('teacher.absent', handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('supports wildcard listeners for teacher.*', () => {
    const payload: EventMap['teacher.absent'] = {
      tenantId: 'tenant-2',
      schemaName: 'ecole_demo_2',
      teacherId: 'teacher-2',
      teacherName: 'Yao Marie',
      subject: 'Francais',
      className: '6e B',
      slotLabel: '10:00-11:00',
      directorPhone: '+2250708091011',
    };

    const wildcardHandler = vi.fn<
      (input: EventMap['teacher.checked_in'] | EventMap['teacher.absent']) => void
    >();

    on('teacher.*', wildcardHandler);
    emit('teacher.absent', payload);
    off('teacher.*', wildcardHandler);

    expect(wildcardHandler).toHaveBeenCalledTimes(1);
    expect(wildcardHandler).toHaveBeenCalledWith(payload);
  });

  it('off() empêche le handler de recevoir les émissions ultérieures', () => {
    const payload: EventMap['teacher.absent'] = {
      tenantId: 'tenant-3',
      schemaName: 'ecole_demo_3',
      teacherId: 'teacher-3',
      teacherName: 'Bamba Aminata',
      subject: 'Anglais',
      className: '3e A',
      slotLabel: '09:00-10:30',
      directorPhone: '+2250100000001',
    };

    const handler = vi.fn<(input: EventMap['teacher.absent']) => void>();

    on('teacher.absent', handler);
    emit('teacher.absent', payload);
    off('teacher.absent', handler);
    emit('teacher.absent', payload);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('délivre le payload typé pour teacher.checked_in', () => {
    const payload: EventMap['teacher.checked_in'] = {
      tenantId: 'tenant-4',
      schemaName: 'ecole_demo_4',
      teacherId: 'teacher-4',
      scheduleId: 'schedule-1',
      date: '2025-01-15',
      checkedInAt: '2025-01-15T07:35:00.000Z',
      checkedInVia: 'app',
    };

    const handler = vi.fn<(input: EventMap['teacher.checked_in']) => void>();

    on('teacher.checked_in', handler);
    emit('teacher.checked_in', payload);
    off('teacher.checked_in', handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('délivre le payload typé pour student.absent', () => {
    const payload: EventMap['student.absent'] = {
      tenantId: 'tenant-5',
      schemaName: 'ecole_demo_5',
      studentId: 'student-1',
      scheduleId: 'schedule-1',
      studentFirstName: 'Kouadio',
      parentPhone: '+2250700000001',
      subject: 'Mathématiques',
      date: '2025-01-15',
      schoolPhone: '+2250200000001',
    };

    const handler = vi.fn<(input: EventMap['student.absent']) => void>();

    on('student.absent', handler);
    emit('student.absent', payload);
    off('student.absent', handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('délivre le payload typé pour subscription.expired', () => {
    const payload: EventMap['subscription.expired'] = {
      tenantId: 'tenant-6',
      directorPhone: '+2250300000001',
    };

    const handler = vi.fn<(input: EventMap['subscription.expired']) => void>();

    on('subscription.expired', handler);
    emit('subscription.expired', payload);
    off('subscription.expired', handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('le wildcard teacher.* ne se déclenche pas sur student.absent', () => {
    const studentPayload: EventMap['student.absent'] = {
      tenantId: 'tenant-7',
      schemaName: 'ecole_demo_7',
      studentId: 'student-2',
      scheduleId: 'schedule-2',
      studentFirstName: 'Adjoua',
      parentPhone: '+2250700000002',
      subject: 'Français',
      date: '2025-01-15',
      schoolPhone: '+2250200000002',
    };

    const wildcardHandler = vi.fn();

    on('teacher.*', wildcardHandler);
    emit('student.absent', studentPayload);
    off('teacher.*', wildcardHandler);

    expect(wildcardHandler).not.toHaveBeenCalled();
  });
});
