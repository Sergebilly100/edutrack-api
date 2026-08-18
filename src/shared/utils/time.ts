/**
 * Time utilities - source unique de vérité pour normalisation
 *
 * QUALITÉ FIX : Élimine duplication entre schedule.api.ts et autres modules
 */

/**
 * Normalise "HH:MM:SS" → "HH:MM". Laisse "HH:MM" inchangé.
 * Ex : "07:30:00" → "07:30" | "08:00" → "08:00"
 */
export const normalizeTime = (raw: string): string => {
  if (!raw) return raw
  const parts = raw.split(":")
  if (parts.length < 2) return raw
  return `${parts[0]}:${parts[1]}`
}

/**
 * Convertit "HH:MM" en minutes depuis minuit
 * Ex: "08:30" → 510
 */
export const timeToMinutes = (time: string): number => {
  const [hours, minutes] = time.split(":").map(Number)
  return (hours || 0) * 60 + (minutes || 0)
}

/**
 * Convertit minutes depuis minuit en "HH:MM"
 * Ex: 510 → "08:30"
 */
export const minutesToTime = (minutes: number): string => {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
}

/**
 * Formate une durée exprimée en heures décimales en "XhYY" lisible.
 * Source unique pour l'affichage des bilans (heures profs, salaires, dashboard).
 *
 * Ex : 7.5 → "7h30" | 7 → "7h" | 0.5 → "30min" | 7.25 → "7h15" | 0 → "0h"
 *
 * QUALITÉ FIX : remplace les `formatHours` locaux divergents et les
 * `.toFixed(1)}h` éparpillés (TeacherProfileCard, TeacherAnalysisPanel,
 * SalariesStatsCards, TeacherDetailPage, DashboardStatsCards, DashboardPage).
 */
export const formatDecimalHours = (value: number): string => {
  if (!Number.isFinite(value)) return "-"
  const sign = value < 0 ? "-" : ""
  // Arrondi à la minute pour éviter "7h29" sur 7.499 ; gère le report (60 → +1h).
  const totalMinutes = Math.round(Math.abs(value) * 60)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (totalMinutes === 0) return "0h"
  if (hours <= 0) return `${sign}${minutes}min`
  if (minutes === 0) return `${sign}${hours}h`
  return `${sign}${hours}h${String(minutes).padStart(2, "0")}`
}
