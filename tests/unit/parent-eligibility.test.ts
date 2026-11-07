import { describe, expect, it } from 'vitest';

import {
  isFreeParentPortalEnabled,
  isParentStudentEligible,
} from '../../src/shared/auth/parent-eligibility.js';

describe('parent portal eligibility', () => {
  it('enables all confirmed linked students in the active free mode', () => {
    const mode = { isEnabled: true, monetizeParentAlerts: false };
    expect(isFreeParentPortalEnabled(mode)).toBe(true);
    expect(isParentStudentEligible(mode, {
      status: null,
      startsAt: null,
      endsAt: null,
    })).toBe(true);
  });

  it('does not infer free access when the parent feature is disabled', () => {
    const mode = { isEnabled: false, monetizeParentAlerts: false };
    expect(isFreeParentPortalEnabled(mode)).toBe(false);
    expect(isParentStudentEligible(mode, {
      status: 'active',
      startsAt: '2026-01-01',
      endsAt: '2027-01-01',
    })).toBe(false);
  });

  it('requires an active, started, non-expired subscription for this student in paid mode', () => {
    const mode = { isEnabled: true, monetizeParentAlerts: true };
    const activeForThisStudent = {
      status: 'active',
      startsAt: '2026-01-01',
      endsAt: '2026-12-31',
    };

    expect(isParentStudentEligible(mode, activeForThisStudent, '2026-06-01')).toBe(true);
    expect(isParentStudentEligible(mode, {
      ...activeForThisStudent,
      status: 'cancelled',
    }, '2026-06-01')).toBe(false);
    expect(isParentStudentEligible(mode, {
      ...activeForThisStudent,
      startsAt: '2026-06-02',
    }, '2026-06-01')).toBe(false);
    expect(isParentStudentEligible(mode, {
      ...activeForThisStudent,
      endsAt: '2026-05-31',
    }, '2026-06-01')).toBe(false);
    expect(isParentStudentEligible(mode, {
      status: null,
      startsAt: null,
      endsAt: null,
    }, '2026-06-01')).toBe(false);
  });
});
