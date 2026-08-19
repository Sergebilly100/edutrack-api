export { PdfBuilder } from './builder.js';
export type { DocumentBranding, LoadedLogo } from './builder.js';
export { fetchSchoolBranding, loadLogo } from './branding.js';
export { buildTheme, defaultTheme } from './theme.js';
export type { PdfTheme } from './theme.js';
export * from './format.js';
export {
  renderTeacherSalaryBilan,
  renderTeacherMultiPeriodBilan,
  renderSchoolSalaryBilan,
} from './templates/salary.js';
export type {
  TeacherSalaryDetails,
  SchoolSalarySummary,
} from './templates/salary.js';
export { renderPaymentHistory } from './templates/payment-history.js';
export type {
  PaymentHistoryPayload,
  PaymentHistoryItem,
} from './templates/payment-history.js';
export { renderTeacherHoursReport } from './templates/teacher-hours.js';
export type {
  TeacherHoursPayload,
  TeacherHoursRow,
} from './templates/teacher-hours.js';
export { renderStudentAbsencesReport } from './templates/student-absences.js';
export type {
  StudentAbsencesPayload,
  StudentAbsenceRow,
} from './templates/student-absences.js';
export { renderTeacherAttendanceReport } from './templates/teacher-attendance.js';
export type {
  TeacherAttendancePayload,
  TeacherAttendanceRow,
} from './templates/teacher-attendance.js';
export { renderRevenueReport } from './templates/revenue.js';
export type { RevenuePayload, RevenueRow } from './templates/revenue.js';
export { renderTuitionReceipt } from './templates/tuition-receipt.js';
export type { TuitionReceiptPayload } from './templates/tuition-receipt.js';
