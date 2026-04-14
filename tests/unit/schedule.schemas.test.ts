import { describe, expect, it } from 'vitest';

import {
  periodPayloadSchema,
  periodUpdatePayloadSchema,
  roomUpdatePayloadSchema,
  schedulePayloadSchema,
} from '../../src/modules/schedule/schedule.schemas.js';

describe('schedule.schemas', () => {
  it('periodUpdatePayloadSchema rejette {}', () => {
    const parsed = periodUpdatePayloadSchema.safeParse({});
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      return;
    }

    expect(parsed.error.issues[0]?.message).toContain('At least one field must be provided');
  });

  it('periodUpdatePayloadSchema accepte { is_active: true }', () => {
    const parsed = periodUpdatePayloadSchema.safeParse({ is_active: true });
    expect(parsed.success).toBe(true);
  });

  it('roomUpdatePayloadSchema rejette {}', () => {
    const parsed = roomUpdatePayloadSchema.safeParse({});
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      return;
    }

    expect(parsed.error.issues[0]?.message).toContain('At least one field must be provided');
  });

  it('schedulePayloadSchema rejette day_of_week=7', () => {
    const parsed = schedulePayloadSchema.safeParse({
      schedule_period_id: '11111111-1111-1111-1111-111111111111',
      teacher_id: '22222222-2222-2222-2222-222222222222',
      class_id: '33333333-3333-3333-3333-333333333333',
      room_id: '44444444-4444-4444-4444-444444444444',
      time_slot_id: '55555555-5555-5555-5555-555555555555',
      day_of_week: 7,
      subject: 'Maths',
    });

    expect(parsed.success).toBe(false);
  });

  it('schedulePayloadSchema rejette day_of_week=0', () => {
    const parsed = schedulePayloadSchema.safeParse({
      schedule_period_id: '11111111-1111-1111-1111-111111111111',
      teacher_id: '22222222-2222-2222-2222-222222222222',
      class_id: '33333333-3333-3333-3333-333333333333',
      room_id: '44444444-4444-4444-4444-444444444444',
      time_slot_id: '55555555-5555-5555-5555-555555555555',
      day_of_week: 0,
      subject: 'Maths',
    });

    expect(parsed.success).toBe(false);
  });

  it('periodPayloadSchema rejette valid_from > valid_to', () => {
    const parsed = periodPayloadSchema.safeParse({
      name: 'Période test',
      valid_from: '2026-04-20',
      valid_to: '2026-04-10',
    });

    expect(parsed.success).toBe(false);
  });
});
