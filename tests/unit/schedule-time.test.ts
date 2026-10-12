import { describe, expect, it } from 'vitest';
import { isValidScheduleInterval, parseScheduleTime } from '../../src/shared/utils/schedule-time.js';

describe('schedule time contract', () => {
  it.each([
    ['00:00', 0], ['23:59', 1439], ['07:15', 435], ['12:20', 740],
    ['24:00', null], ['12:60', null], ['', null], ['7:15', null], ['07:15x', null],
  ])('parses %s as %s', (value, expected) => {
    expect(parseScheduleTime(value)).toBe(expected);
  });

  it('accepts adjacent intervals and rejects null or reversed intervals', () => {
    expect(isValidScheduleInterval('07:15', '08:05')).toBe(true);
    expect(isValidScheduleInterval('08:05', '08:30')).toBe(true);
    expect(isValidScheduleInterval('08:05', '08:05')).toBe(false);
    expect(isValidScheduleInterval('08:30', '07:45')).toBe(false);
  });
});
