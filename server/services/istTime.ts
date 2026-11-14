const IST_TZ = 'Asia/Kolkata';

/**
 * Returns YYYY-MM-DD in Asia/Kolkata (IST) for a given Date.
 * Uses en-CA locale which formats deterministically as YYYY-MM-DD.
 */
export function getIstDateIso(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = parts.find((p) => p.type === 'year')?.value || '2026';
  const month = parts.find((p) => p.type === 'month')?.value || '01';
  const day = parts.find((p) => p.type === 'day')?.value || '01';
  return `${year}-${month}-${day}`;
}

/**
 * Returns localized hh:mm AM/PM in Asia/Kolkata (IST).
 */
export function getIstTimeFormatted(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: IST_TZ,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

/**
 * Returns integer IST hour (0-23) and minute (0-59).
 */
export function getIstHourMinute(date: Date = new Date()): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: IST_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const rawHour = Number(parts.find((p) => p.type === 'hour')?.value || '0');
  const hour = rawHour === 24 ? 0 : rawHour;
  const minute = Number(parts.find((p) => p.type === 'minute')?.value || '0');
  return { hour, minute };
}

/**
 * Formats YYYY-MM-DD as "18 Nov 2026".
 */
export function formatIstDateShort(isoDate: string): string {
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return isoDate;
  const utcMidday = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0));
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TZ,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(utcMidday);
}

/**
 * Formats YYYY-MM-DD as "18 November 2026".
 */
export function formatIstDateLong(isoDate: string): string {
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return isoDate;
  const utcMidday = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0));
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TZ,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(utcMidday);
}

/**
 * Returns signed calendar-day difference: targetIso - baseIso.
 * Uses pure UTC day numbers on YYYY-MM-DD strings to avoid DST/midnight edge bugs.
 */
export function diffCalendarDaysIso(targetIso: string, baseIso: string): number {
  const t = targetIso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const b = baseIso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!t || !b) return 0;
  const tMs = Date.UTC(Number(t[1]), Number(t[2]) - 1, Number(t[3]));
  const bMs = Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3]));
  return Math.round((tMs - bMs) / 86400000);
}

export function addDaysIso(baseIso: string, offsetDays: number): string {
  const b = baseIso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!b) return baseIso;
  const dt = new Date(Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3]) + offsetDays, 12, 0, 0));
  return dt.toISOString().slice(0, 10);
}

export function formatAppointmentCountdown(appointmentDate: string, todayIst: string): string {
  const diff = diffCalendarDaysIso(appointmentDate, todayIst);
  if (diff > 1) return `In ${diff} days`;
  if (diff === 1) return 'Tomorrow (Reminder window)';
  if (diff === 0) return 'Today';
  return `${Math.abs(diff)} day${Math.abs(diff) === 1 ? '' : 's'} ago`;
}

export function parseSlotToMinutesOfDay(slot: string): number | null {
  const m = slot.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let hr = Number(m[1]);
  const min = Number(m[2]);
  const mer = m[3].toUpperCase();
  if (mer === 'PM' && hr < 12) hr += 12;
  if (mer === 'AM' && hr === 12) hr = 0;
  return hr * 60 + min;
}
