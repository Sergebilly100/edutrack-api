import { describe, it, expect, beforeEach, vi } from 'vitest';
import { autoApproveOldGeoValidations } from '../../src/modules/attendance/attendance.geo-auto-approve.js';

describe('Geo Auto-Approve', () => {
  let mockDb: any;

  beforeEach(() => {
    mockDb = {
      execute: vi.fn(),
    };
  });

  it('should auto-approve validations older than 7 days', async () => {
    mockDb.execute.mockResolvedValue({
      rows: [{ count: 5 }],
    });

    const count = await autoApproveOldGeoValidations(mockDb, 'school_abc');

    expect(count).toBe(5);
    expect(mockDb.execute).toHaveBeenCalledTimes(1);

    const query = mockDb.execute.mock.calls[0][0];
    const queryStr = query.queryChunks
      .flatMap((c: { value?: string[] }) => (Array.isArray(c.value) ? c.value : []))
      .join('');

    expect(queryStr).toContain('validation_status = \'approved\'');
    expect(queryStr).toContain('geo_status = \'verified\'');
    expect(queryStr).toContain('validation_status = \'pending\'');
    expect(queryStr).toContain('geo_status = \'suspicious\'');
    expect(queryStr).toContain('INTERVAL ');
  });

  it('should return 0 if no validations to approve', async () => {
    mockDb.execute.mockResolvedValue({
      rows: [{ count: 0 }],
    });

    const count = await autoApproveOldGeoValidations(mockDb, 'school_xyz');

    expect(count).toBe(0);
  });

  it('should handle non-numeric count', async () => {
    mockDb.execute.mockResolvedValue({
      rows: [{ count: '12' }],
    });

    const count = await autoApproveOldGeoValidations(mockDb, 'school_test');

    expect(count).toBe(12);
  });

  it('should handle empty result', async () => {
    mockDb.execute.mockResolvedValue({
      rows: [],
    });

    const count = await autoApproveOldGeoValidations(mockDb, 'school_empty');

    expect(count).toBe(0);
  });
});
