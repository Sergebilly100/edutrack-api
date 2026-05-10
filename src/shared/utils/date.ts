/**
 * Date utilities pour éliminer duplication
 */

export const monthBoundsFromDate = (date: string): { monthStart: string; monthEnd: string } => {
  const monthStart = `${date.slice(0, 7)}-01`;
  const [yearRaw, monthRaw] = date.slice(0, 7).split('-');
  const m = Number(monthRaw);
  const y = Number(yearRaw);
  const end = new Date(
    Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 0)
  );
  return { monthStart, monthEnd: end.toISOString().slice(0, 10) };
};

export const currentDateIso = (): string => new Date().toISOString().slice(0, 10);

export const toIso = (date: Date): string => date.toISOString();

export const dayOfWeekFromDate = (date: Date): number => {
  const d = date.getUTCDay();
  return d === 0 ? 7 : d;
};

export const toSlotDateTime = (date: string, time: string): Date =>
  new Date(`${date}T${time}.000Z`);
