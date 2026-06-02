import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import type { DocumentBranding } from '../../src/shared/pdf/builder.js';
import {
  renderPaymentHistory,
  renderSchoolSalaryBilan,
  renderTeacherMultiPeriodBilan,
  renderTeacherSalaryBilan,
  type SchoolSalarySummary,
  type TeacherSalaryDetails,
} from '../../src/shared/pdf/index.js';

const branding: DocumentBranding = {
  schoolName: 'Groupe Scolaire La Réussite d’Abidjan-Cocody',
  schoolMeta: 'Abidjan',
  signatoryTitle: 'Directeur',
  logo: null,
};

const PDF_MAGIC = '%PDF';

const isValidPdf = async (bytes: Uint8Array): Promise<number> => {
  expect(Buffer.from(bytes.slice(0, 4)).toString('latin1')).toBe(PDF_MAGIC);
  const doc = await PDFDocument.load(bytes);
  return doc.getPageCount();
};

const teacher = (rows: number): TeacherSalaryDetails => ({
  month: '2026-05',
  teacher: {
    id: 't1',
    name: 'M. Kouassi N’Guessan Jean-Baptiste',
    type: 'vacataire',
    hourlyRate: 3500,
    monthlySalary: null,
  },
  summary: {
    hoursPlanned: rows,
    hoursDone: Math.round(rows * 0.7),
    totalFcfa: Math.round(rows * 0.7) * 3500,
    status: 'pending',
    amountAlreadyPaid: 0,
    amountRemainingToPayNow: Math.round(rows * 0.7) * 3500,
  },
  payment: { paidAt: null, paidByName: null, notes: null },
  rows: Array.from({ length: rows }, (_, i) => ({
    date: `2026-05-${String((i % 28) + 1).padStart(2, '0')}`,
    slotLabel: '08h00 – 09h00',
    subject: 'Sciences de la Vie et de la Terre',
    className: '3ème A',
    attendanceStatus: ['present', 'late', 'absent'][i % 3]!,
    lateMinutes: i % 3 === 1 ? 10 : null,
    hoursDone: i % 3 === 2 ? 0 : 1,
  })),
});

describe('pdf/templates — bilan salaire professeur', () => {
  it('produit un PDF valide avec quelques séances', async () => {
    const pages = await isValidPdf(await renderTeacherSalaryBilan(branding, teacher(12)));
    expect(pages).toBeGreaterThanOrEqual(1);
  });

  it('pagine quand il y a beaucoup de séances', async () => {
    const pages = await isValidPdf(await renderTeacherSalaryBilan(branding, teacher(80)));
    expect(pages).toBeGreaterThan(1);
  });

  it('gère le cas sans aucune séance', async () => {
    const pages = await isValidPdf(
      await renderTeacherSalaryBilan(branding, { ...teacher(0), rows: [] })
    );
    expect(pages).toBe(1);
  });
});

describe('pdf/templates — bilan école & multi-période', () => {
  it('bilan école avec de nombreux professeurs', async () => {
    const summary: SchoolSalarySummary = {
      month: '2026-05',
      items: Array.from({ length: 40 }, (_, i) => ({
        teacherName: `Professeur Numéro ${i + 1} au Nom Particulièrement Long`,
        teacherType: (i % 2 ? 'permanent' : 'vacataire') as 'permanent' | 'vacataire',
        hoursPlanned: 20 + i,
        hoursDone: 15 + i,
        totalFcfa: (15 + i) * 3000,
        amountAlreadyPaid: i % 3 === 0 ? (15 + i) * 3000 : 0,
        status: ['paid', 'pending', 'disputed', 'nothing_to_pay'][i % 4]!,
      })),
    };
    const pages = await isValidPdf(await renderSchoolSalaryBilan(branding, summary));
    expect(pages).toBeGreaterThan(1);
  });

  it('bilan école vide', async () => {
    const pages = await isValidPdf(
      await renderSchoolSalaryBilan(branding, { month: '2026-05', items: [] })
    );
    expect(pages).toBe(1);
  });

  it('multi-période agrège plusieurs mois', async () => {
    const pages = await isValidPdf(
      await renderTeacherMultiPeriodBilan(branding, '2026-01', '2026-04', [
        teacher(10),
        teacher(14),
        teacher(8),
        teacher(12),
      ])
    );
    expect(pages).toBeGreaterThanOrEqual(1);
  });
});

describe('pdf/templates — branding logo', () => {
  // PNG bleu 64×64 valide (encodé en base64) pour exercer l'embed du logo.
  const LOGO_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGNQTX79Hx9mGBkKAFT4nIFZlBMAAAAAAElFTkSuQmCC';

  it('embarque un logo PNG dans l’en-tête', async () => {
    const withLogo: DocumentBranding = {
      schoolName: 'Collège Moderne d’Adzopé',
      schoolMeta: 'Adzopé',
      signatoryTitle: 'Principal',
      logo: { bytes: Uint8Array.from(Buffer.from(LOGO_PNG_B64, 'base64')), format: 'png' },
    };
    const pages = await isValidPdf(await renderTeacherSalaryBilan(withLogo, teacher(10)));
    expect(pages).toBeGreaterThanOrEqual(1);
  });
});

describe('pdf/templates — historique des paiements', () => {
  it('produit un PDF valide avec période de couverture', async () => {
    const pages = await isValidPdf(
      await renderPaymentHistory(branding, {
        teacher: { name: 'Mme Bamba Aïssata', type: 'permanent' },
        periodFrom: '2025-09',
        periodTo: '2026-08',
        items: [
          { month: '2025-09', amountFcfa: 250000, hoursPaid: null, status: 'paid', paidAt: '2025-10-02T10:00:00Z', paidByName: 'Secrétaire', notes: 'œuvre 50€' },
          { month: '2025-10', amountFcfa: 250000, hoursPaid: null, status: 'pending', paidAt: null, paidByName: null, notes: null },
        ],
      })
    );
    expect(pages).toBe(1);
  });

  it('gère un historique vide', async () => {
    const pages = await isValidPdf(
      await renderPaymentHistory(branding, {
        teacher: { name: 'Prof Sans Paiement', type: 'vacataire' },
        periodFrom: '2026-01',
        periodTo: '2026-04',
        items: [],
      })
    );
    expect(pages).toBe(1);
  });
});
