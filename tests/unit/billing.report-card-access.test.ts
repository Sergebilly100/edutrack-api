import { describe, expect, it } from 'vitest';

import { canReadReportCardJob } from '../../src/modules/billing/billing.helpers.js';
import type { PermissionKey } from '../../src/shared/types/index.js';

const permissions = (...values: PermissionKey[]): ReadonlySet<PermissionKey> => new Set(values);

describe('report card PDF job access', () => {
  const job = { schemaName: 'school_one', parentId: 'parent_one' };

  it('allows school staff with report or enrollment access', () => {
    expect(canReadReportCardJob(job, { schemaName: 'school_one', permissions: permissions('report_cards.view') })).toBe(true);
    expect(canReadReportCardJob(job, { schemaName: 'school_one', permissions: permissions('enrollments.view') })).toBe(true);
  });

  it('allows only the parent who requested the job', () => {
    expect(canReadReportCardJob(job, { schemaName: 'school_one', role: 'parent', userId: 'parent_one' })).toBe(true);
    expect(canReadReportCardJob(job, { schemaName: 'school_one', role: 'parent', userId: 'parent_two' })).toBe(false);
    expect(canReadReportCardJob({ schemaName: 'school_one' }, { schemaName: 'school_one', role: 'parent', userId: 'parent_one' })).toBe(false);
  });

  it('rejects access from another school or without a permission', () => {
    expect(canReadReportCardJob(job, { schemaName: 'school_two', permissions: permissions('report_cards.view') })).toBe(false);
    expect(canReadReportCardJob(job, { schemaName: 'school_one', permissions: permissions() })).toBe(false);
  });
});
