import { describe, expect, it } from 'vitest';
import { resolveScheduleSubjectDisplay } from '../../src/shared/utils/schedule-subject-display.js';

describe('resolveScheduleSubjectDisplay', () => {
  it('uses the abbreviation for the only normalized match in the class level', () => {
    expect(resolveScheduleSubjectDisplay('Mathematiques', [
      { name: 'Mathématiques', abbreviation: ' Maths ' },
      { name: 'Français', abbreviation: 'Fr' },
    ])).toBe('Maths');
  });

  it('keeps the stored subject for missing, blank and ambiguous references', () => {
    const subject = 'Mathématiques';
    expect(resolveScheduleSubjectDisplay(subject, [])).toBe(subject);
    expect(resolveScheduleSubjectDisplay(subject, [{ name: subject, abbreviation: null }])).toBe(subject);
    expect(resolveScheduleSubjectDisplay(subject, [{ name: subject, abbreviation: '   ' }])).toBe(subject);
    expect(resolveScheduleSubjectDisplay(subject, [
      { name: 'Mathématique', abbreviation: 'Maths' },
      { name: 'Mathématiques', abbreviation: 'Math.' },
    ])).toBe(subject);
  });

  it('does not use an abbreviation from another level', () => {
    expect(resolveScheduleSubjectDisplay('Mathématiques', [
      { name: 'Français', abbreviation: 'Maths' },
    ])).toBe('Mathématiques');
  });
});
