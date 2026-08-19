import { describe, expect, it } from 'vitest';

import {
  renderRevenueReport,
  renderStudentAbsencesReport,
  renderTeacherAttendanceReport,
  renderTeacherHoursReport,
  renderCashJournal,
  type RevenuePayload,
  type StudentAbsencesPayload,
  type TeacherAttendancePayload,
  type TeacherHoursPayload,
} from '../../src/shared/pdf/index.js';

const branding = {
  schoolName: 'Lycée Test',
  schoolMeta: 'Abidjan',
  logo: null,
  signatoryTitle: 'Directeur',
};

const PDF_MAGIC = '%PDF';

const expectPdf = (bytes: Uint8Array): void => {
  const header = Buffer.from(bytes.slice(0, 4)).toString('latin1');
  expect(bytes.length).toBeGreaterThan(1000);
  expect(header).toBe(PDF_MAGIC);
};

describe('export PDF templates', () => {
  it('renders the cash journal with filtered entries and totals', async () => {
    expectPdf(await renderCashJournal(branding, {
      from: '2026-08-01', to: '2026-08-31',
      totals: { cash: 25_000, mobile_money: 15_000, bank_transfer: 0, grandTotal: 40_000 },
      entries: [{
        paymentDate: '2026-08-19', studentName: 'Awa Koné', className: '6ème A',
        amount: 25_000, method: 'cash', reference: 'CAISSE-001', status: 'confirmed',
      }],
    }));
  });

  describe('teacher hours report', () => {
    const base: TeacherHoursPayload = {
      teacher: { name: 'Awa Koné' },
      periodFrom: '2026-05-01',
      periodTo: '2026-05-31',
      rows: [
        {
          date: '2026-05-04',
          subject: 'Maths',
          className: '3e A',
          roomName: 'Salle 12',
          startTime: '08:00',
          endTime: '10:00',
          attendanceStatus: 'present',
          lateMinutes: null,
          rollcallDone: true,
          studentPresentCount: 28,
          studentAbsentCount: 2,
          studentTotalCount: 30,
        },
        {
          date: '2026-05-05',
          subject: 'Maths',
          className: '3e A',
          roomName: 'Salle 12',
          startTime: '08:00',
          endTime: '10:00',
          attendanceStatus: 'late',
          lateMinutes: 15,
          rollcallDone: false,
          studentPresentCount: 0,
          studentAbsentCount: 0,
          studentTotalCount: 30,
        },
      ],
    };

    it('renders a non-empty PDF with rows', async () => {
      expectPdf(await renderTeacherHoursReport(branding, base));
    });

    it('renders a non-empty PDF when there are no rows', async () => {
      expectPdf(await renderTeacherHoursReport(branding, { ...base, rows: [] }));
    });
  });

  describe('student absences report', () => {
    const base: StudentAbsencesPayload = {
      studentLabel: 'Élève',
      from: '2026-05-01',
      to: '2026-05-31',
      rows: [
        {
          studentName: 'Koffi Yao',
          className: '6e B',
          absenceCount: 5,
          absenceRate: 12.5,
          parentPhone: '2250102030405',
          parentPhone2: null,
          smsSummary: 'all_sent',
        },
        {
          studentName: 'Aya Traoré',
          className: '6e B',
          absenceCount: 3,
          absenceRate: 7.5,
          parentPhone: null,
          parentPhone2: null,
          smsSummary: 'none',
        },
      ],
    };

    it('renders a non-empty PDF with rows', async () => {
      expectPdf(await renderStudentAbsencesReport(branding, base));
    });

    it('renders a non-empty PDF when there are no rows', async () => {
      expectPdf(await renderStudentAbsencesReport(branding, { ...base, rows: [] }));
    });
  });

  describe('teacher attendance report', () => {
    const base: TeacherAttendancePayload = {
      from: '2026-05-01',
      to: '2026-05-31',
      rows: [
        {
          teacherName: 'Awa Koné',
          teacherType: 'vacataire',
          attendanceRate: 92.3,
          presentCount: 24,
          totalScheduled: 26,
          hoursDone: 48,
          hoursScheduled: 52,
          lateCount: 1,
          roomMismatchCount: 0,
          rollcallMissingCount: 2,
        },
      ],
    };

    it('renders a non-empty PDF with rows', async () => {
      expectPdf(await renderTeacherAttendanceReport(branding, base));
    });

    it('renders a non-empty PDF when there are no rows', async () => {
      expectPdf(await renderTeacherAttendanceReport(branding, { ...base, rows: [] }));
    });
  });

  describe('revenue report', () => {
    const base: RevenuePayload = {
      periodFrom: '2026-03',
      periodTo: '2026-05',
      rows: [
        {
          month: '2026-05',
          subscriptionsNewThisMonth: 12,
          subscriptionsActiveCount: 140,
          totalCollectedFcfa: 1_400_000,
          commissionDueFcfa: 210_000,
          commissionPaidFcfa: 100_000,
          commissionRemainingFcfa: 110_000,
          paymentStatus: 'partial',
        },
        {
          month: '2026-04',
          subscriptionsNewThisMonth: 8,
          subscriptionsActiveCount: 128,
          totalCollectedFcfa: 1_280_000,
          commissionDueFcfa: 192_000,
          commissionPaidFcfa: 192_000,
          commissionRemainingFcfa: 0,
          paymentStatus: 'paid',
        },
      ],
    };

    it('renders a non-empty PDF with rows', async () => {
      expectPdf(await renderRevenueReport(branding, base));
    });

    it('renders a non-empty PDF when there are no rows', async () => {
      expectPdf(await renderRevenueReport(branding, { ...base, rows: [] }));
    });
  });
});
