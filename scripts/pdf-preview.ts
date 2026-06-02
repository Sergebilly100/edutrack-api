/**
 * Génère des PDF d'exemple avec des données variées (beaucoup de matières, noms
 * longs, logo absent, accents) pour vérifier visuellement le rendu.
 *
 *   npx tsx scripts/pdf-preview.ts
 *
 * Les fichiers sont écrits dans /tmp/edutrack-pdf-preview/.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { PDFDocument } from 'pdf-lib';

import type { DocumentBranding } from '../src/shared/pdf/builder.js';
import {
  renderPaymentHistory,
  renderSchoolSalaryBilan,
  renderTeacherMultiPeriodBilan,
  renderTeacherSalaryBilan,
  type SchoolSalarySummary,
  type TeacherSalaryDetails,
} from '../src/shared/pdf/index.js';

const OUT = '/tmp/edutrack-pdf-preview';

// On teste sans logo (cas réel fréquent).
const brandingNoLogo: DocumentBranding = {
  schoolName: 'Groupe Scolaire La Réussite d’Abidjan-Cocody',
  schoolMeta: 'Abidjan',
  signatoryTitle: 'Directeur',
  logo: null,
};

// …et avec un logo PNG (mark bleu 64×64) pour vérifier le cartouche d'en-tête.
const LOGO_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGNQTX79Hx9mGBkKAFT4nIFZlBMAAAAAAElFTkSuQmCC';
const brandingWithLogo: DocumentBranding = {
  schoolName: 'Collège Moderne d’Adzopé',
  schoolMeta: 'Adzopé',
  signatoryTitle: 'Principal',
  logo: { bytes: Uint8Array.from(Buffer.from(LOGO_PNG_B64, 'base64')), format: 'png' },
};

const SUBJECTS = [
  'Mathématiques',
  'Français',
  'Physique-Chimie',
  'Sciences de la Vie et de la Terre',
  'Histoire-Géographie',
  'Anglais',
  'Éducation Physique et Sportive',
  'Philosophie',
];
const CLASSES = ['6ème A', '5ème B', '4ème C', '3ème A', '2nde S', 'Tle D'];
const STATUSES = ['present', 'late', 'absent', 'excused', 'not_marked'];

const buildRows = (count: number): TeacherSalaryDetails['rows'] =>
  Array.from({ length: count }, (_, i) => {
    const status = STATUSES[i % STATUSES.length]!;
    const day = (i % 28) + 1;
    return {
      date: `2026-05-${String(day).padStart(2, '0')}`,
      slotLabel: `${8 + (i % 5)}h00 – ${9 + (i % 5)}h00`,
      subject: SUBJECTS[i % SUBJECTS.length]!,
      className: CLASSES[i % CLASSES.length]!,
      attendanceStatus: status,
      lateMinutes: status === 'late' ? 5 + (i % 20) : null,
      hoursDone: status === 'present' || status === 'late' || status === 'excused' ? 1 : 0,
    };
  });

const teacherDetails = (month: string, rowCount: number): TeacherSalaryDetails => ({
  month,
  teacher: {
    id: 't1',
    name: 'M. Kouassi N’Guessan Jean-Baptiste',
    type: 'vacataire',
    hourlyRate: 3500,
    monthlySalary: null,
  },
  summary: {
    hoursPlanned: rowCount,
    hoursDone: Math.round(rowCount * 0.7),
    totalFcfa: Math.round(rowCount * 0.7) * 3500,
    status: 'pending',
    absenceHours: Math.round(rowCount * 0.2),
    amountAlreadyPaid: 50000,
    amountRemainingToPayNow: Math.max(0, Math.round(rowCount * 0.7) * 3500 - 50000),
  },
  payment: {
    paidAt: '2026-05-20T09:30:00Z',
    paidByName: 'Mme Aké (Secrétaire)',
    notes: 'Avance partielle réglée en espèces.',
  },
  rows: buildRows(rowCount),
});

const schoolSummary: SchoolSalarySummary = {
  month: '2026-05',
  items: [
    { teacherName: 'M. Kouassi N’Guessan Jean-Baptiste', teacherType: 'vacataire', hoursPlanned: 40, hoursDone: 38, totalFcfa: 133000, amountAlreadyPaid: 100000, status: 'pending' },
    { teacherName: 'Mme Bamba Aïssata', teacherType: 'permanent', hoursPlanned: 60, hoursDone: 60, totalFcfa: 250000, amountAlreadyPaid: 250000, status: 'paid' },
    { teacherName: 'M. Yao Konan', teacherType: 'vacataire', hoursPlanned: 20, hoursDone: 0, totalFcfa: 0, amountAlreadyPaid: 0, status: 'nothing_to_pay' },
    { teacherName: 'Mlle Touré Fatoumata Mariam', teacherType: 'vacataire', hoursPlanned: 30, hoursDone: 25, totalFcfa: 87500, amountAlreadyPaid: 0, status: 'disputed' },
    ...Array.from({ length: 18 }, (_, i) => ({
      teacherName: `Professeur Test Numéro ${i + 5}`,
      teacherType: (i % 2 === 0 ? 'vacataire' : 'permanent') as 'vacataire' | 'permanent',
      hoursPlanned: 20 + i,
      hoursDone: 15 + i,
      totalFcfa: (15 + i) * 3000,
      amountAlreadyPaid: i % 3 === 0 ? (15 + i) * 3000 : 0,
      status: i % 3 === 0 ? 'paid' : 'pending',
    })),
  ],
};

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });

  const cases: Array<[string, Promise<Uint8Array>]> = [
    ['teacher-standard.pdf', renderTeacherSalaryBilan(brandingNoLogo, teacherDetails('2026-05', 12))],
    ['teacher-with-logo.pdf', renderTeacherSalaryBilan(brandingWithLogo, teacherDetails('2026-05', 14))],
    ['teacher-many-sessions.pdf', renderTeacherSalaryBilan(brandingNoLogo, teacherDetails('2026-05', 60))],
    [
      'teacher-empty.pdf',
      renderTeacherSalaryBilan(brandingNoLogo, { ...teacherDetails('2026-05', 0), rows: [] }),
    ],
    ['school-payroll.pdf', renderSchoolSalaryBilan(brandingNoLogo, schoolSummary)],
    [
      'teacher-multiperiod.pdf',
      renderTeacherMultiPeriodBilan(brandingNoLogo, '2026-01', '2026-04', [
        teacherDetails('2026-01', 10),
        teacherDetails('2026-02', 14),
        teacherDetails('2026-03', 8),
        teacherDetails('2026-04', 12),
      ]),
    ],
    [
      'payment-history.pdf',
      renderPaymentHistory(brandingNoLogo, {
        teacher: { name: 'M. Kouassi N’Guessan Jean-Baptiste', type: 'vacataire' },
        periodFrom: '2026-01',
        periodTo: '2026-04',
        items: [
          { month: '2026-01', amountFcfa: 120000, hoursPaid: 34, status: 'paid', paidAt: '2026-02-03T10:00:00Z', paidByName: 'Mme Aké', notes: 'RAS' },
          { month: '2026-02', amountFcfa: 98000, hoursPaid: 28, status: 'paid', paidAt: '2026-03-02T11:30:00Z', paidByName: 'Mme Aké', notes: null },
          { month: '2026-03', amountFcfa: 45000, hoursPaid: 13, status: 'pending', paidAt: null, paidByName: null, notes: 'Solde en attente' },
          { month: '2026-04', amountFcfa: 87500, hoursPaid: 25, status: 'disputed', paidAt: '2026-05-04T09:00:00Z', paidByName: 'M. le Directeur', notes: 'Litige sur 2 séances annulées' },
        ],
      }),
    ],
  ];

  for (const [name, bytesPromise] of cases) {
    const bytes = await bytesPromise;
    const file = path.join(OUT, name);
    await writeFile(file, bytes);
    const pages = (await PDFDocument.load(bytes)).getPageCount();
    console.log(`✓ ${name} (${(bytes.length / 1024).toFixed(1)} Ko, ${pages} page(s))`);
  }
  console.log(`\nPDFs générés dans ${OUT}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
