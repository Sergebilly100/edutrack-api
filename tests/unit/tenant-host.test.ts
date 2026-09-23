import { describe, expect, it } from 'vitest';

import {
  resolveTenantFromHostname,
  resolveTenantSubdomainFromHostname,
} from '../../src/shared/tenancy/tenant-host.js';

const emptyHostMappings = { hostMappings: [] };

describe('resolveTenantSubdomainFromHostname', () => {
  it('keeps existing first-label tenant hosts without configuration', () => {
    expect(
      resolveTenantSubdomainFromHostname('sainte-marie.ivoiredu.ci', {
        baseDomains: [],
        environmentPrefixes: [],
        ...emptyHostMappings,
      })
    ).toBe('sainte-marie');
  });

  it('extracts the tenant after an environment prefix on configured base domains', () => {
    expect(
      resolveTenantSubdomainFromHostname('dev.ivoiredu.novatrixsys.com', {
        baseDomains: ['novatrixsys.com'],
        environmentPrefixes: ['dev', 'staging'],
        ...emptyHostMappings,
      })
    ).toBe('ivoiredu');
  });

  it('supports explicit host to schema mappings', () => {
    expect(
      resolveTenantFromHostname('dev.ivoiredu.novatrixsys.com', {
        baseDomains: ['novatrixsys.com'],
        environmentPrefixes: ['dev', 'staging'],
        hostMappings: [
          {
            hostname: 'dev.ivoiredu.novatrixsys.com',
            target: 'school_sainte_marie',
            targetType: 'schema',
          },
        ],
      })
    ).toEqual({ value: 'school_sainte_marie', type: 'schema' });
  });

  it('ignores reserved tenant labels', () => {
    expect(
      resolveTenantSubdomainFromHostname('admin.ivoiredu.ci', {
        baseDomains: ['ivoiredu.ci'],
        environmentPrefixes: ['dev'],
        ...emptyHostMappings,
      })
    ).toBeNull();
  });
});
