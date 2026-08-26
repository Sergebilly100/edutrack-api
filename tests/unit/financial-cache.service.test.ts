import { describe, expect, it } from 'vitest';

import {
  computeRecoveryRate,
  resolveCacheStatus,
} from '../../src/modules/finance/financial-cache.service.js';

describe('resolveCacheStatus (statut de cache financier)', () => {
  it('up_to_date quand le payé couvre le dû à date', () => {
    expect(resolveCacheStatus({ expectedToDate: 100_000, paidConfirmed: 100_000, waivedAmount: 0 })).toBe('up_to_date');
    expect(resolveCacheStatus({ expectedToDate: 100_000, paidConfirmed: 150_000, waivedAmount: 0 })).toBe('up_to_date');
  });

  it('late quand le payé est insuffisant', () => {
    expect(resolveCacheStatus({ expectedToDate: 100_000, paidConfirmed: 40_000, waivedAmount: 0 })).toBe('late');
  });

  it('waived quand la remise couvre entièrement le dû à date', () => {
    expect(resolveCacheStatus({ expectedToDate: 100_000, paidConfirmed: 0, waivedAmount: 100_000 })).toBe('waived');
  });

  it('reste up_to_date avec aucun dû attendu à ce jour', () => {
    expect(resolveCacheStatus({ expectedToDate: 0, paidConfirmed: 0, waivedAmount: 0 })).toBe('up_to_date');
  });
});

describe('computeRecoveryRate (taux de recouvrement)', () => {
  it('calcule un ratio borné à [0,1]', () => {
    expect(computeRecoveryRate(50_000, 100_000)).toBe(0.5);
    expect(computeRecoveryRate(150_000, 100_000)).toBe(1);
    expect(computeRecoveryRate(0, 100_000)).toBe(0);
  });

  it("renvoie 1 quand rien n'est encore attendu", () => {
    expect(computeRecoveryRate(25_000, 0)).toBe(1);
  });
});
