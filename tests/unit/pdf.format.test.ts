import { describe, expect, it } from 'vitest';

import {
  formatFcfa,
  formatHours,
  formatMonthLabel,
  formatPeriodCoverage,
  formatAttendanceStatus,
  formatSalaryStatus,
} from '../../src/shared/pdf/format.js';

describe('pdf/format - montants & heures', () => {
  it('formate les FCFA avec séparateurs de milliers', () => {
    expect(formatFcfa(1739500)).toBe('1 739 500 FCFA');
    expect(formatFcfa(0)).toBe('0 FCFA');
  });

  it('renvoie un tiret pour null / NaN', () => {
    expect(formatFcfa(null)).toBe('—');
    expect(formatFcfa(undefined)).toBe('—');
    expect(formatHours(null)).toBe('—');
  });

  it('formate les heures avec au plus 2 décimales', () => {
    expect(formatHours(12)).toBe('12 h');
    expect(formatHours(12.5)).toBe('12,5 h');
  });
});

describe('pdf/format - période de couverture', () => {
  it('même année → « Janvier – Avril 2026 »', () => {
    expect(formatPeriodCoverage('2026-01', '2026-04')).toBe('Janvier – Avril 2026');
  });

  it('un seul mois → libellé du mois', () => {
    expect(formatPeriodCoverage('2026-05', '2026-05')).toBe('Mai 2026');
  });

  it('changement d’année → mois+année des deux bornes', () => {
    expect(formatPeriodCoverage('2025-12', '2026-03')).toBe('Décembre 2025 – Mars 2026');
  });

  it('année scolaire CI (septembre → août)', () => {
    expect(formatPeriodCoverage('2025-09', '2026-08')).toBe('Septembre 2025 – Août 2026');
  });

  it('mois isolé capitalisé', () => {
    expect(formatMonthLabel('2026-02')).toBe('Février 2026');
  });
});

describe('pdf/format - statuts', () => {
  it('traduit les statuts de salaire', () => {
    expect(formatSalaryStatus('paid')).toBe('Payé');
    expect(formatSalaryStatus('pending')).toBe('En attente');
    expect(formatSalaryStatus('disputed')).toBe('Litige');
    expect(formatSalaryStatus('nothing_to_pay')).toBe('Rien à payer');
  });

  it('affiche les minutes de retard', () => {
    expect(formatAttendanceStatus('late', 12)).toBe('Retard 12 min');
    expect(formatAttendanceStatus('late', 0)).toBe('Retard');
    expect(formatAttendanceStatus('present')).toBe('Présent');
    expect(formatAttendanceStatus('absent')).toBe('Absent');
  });
});
