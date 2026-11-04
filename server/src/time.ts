// Dates and time zones. Sample dates are in UTC; days are counted in the local
// time zone, as the phone shows them. To use another zone, change TIME_ZONE and the
// fast offset below (STANDARD_OFFSET_HOURS and the summer time rule).

export const TIME_ZONE = "Europe/Rome";

// Same format as dates sent by the app: no milliseconds.
export function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Local date of an instant, in 2026-10-04 format. No Intl: called
// for each sample and Intl would cost too much CPU time (see localOffsetMs).
export function localDay(date: Date): string {
  const t = date.getTime();
  return new Date(t + localOffsetMs(t)).toISOString().slice(0, 10);
}

// Calendar day arithmetic, without time zones in between.
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// The last `count` days ending with `last`, from oldest.
export function dayRange(last: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDays(last, i - count + 1));
}

// Intl formatters are created once: creating them costs more than using them.
const dayLabel = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
const dateTimeLabel = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
});
const timeLabel = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit" });
const secondsLabel = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

export function formatDay(day: string): string {
  return dayLabel.format(new Date(`${day}T12:00:00Z`));
}

export function formatDateTime(date: Date): string {
  return dateTimeLabel.format(date);
}

// With seconds: two page copies generated minutes apart remain distinguishable.
export function formatDateTimeSeconds(date: Date): string {
  return secondsLabel.format(date);
}

export function formatTime(date: Date): string {
  return timeLabel.format(date);
}

// UTC instant of local midnight for that day. The offset is read at 1 AM
// local time (23 UTC the day before), so it's correct even on DST change days.
export function localMidnightUtc(day: string): string {
  const probe = new Date(`${addDays(day, -1)}T23:00:00Z`);
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, timeZoneName: "shortOffset" })
    .formatToParts(probe).find((p) => p.type === "timeZoneName")?.value ?? "GMT+1";
  const hours = Number(offset.replace("GMT", "") || 0);
  const midnight = new Date(`${day}T00:00:00Z`);
  midnight.setUTCHours(midnight.getUTCHours() - hours);
  return isoSeconds(midnight);
}

// Fast local time, no Intl. Central European Time: UTC+1, summer time (+1 hour) from
// the last Sunday of March to the last Sunday of October, at 01:00 UTC. Needed for exports with thousands of rows, where Intl
// would cost too much CPU time.
const STANDARD_OFFSET_HOURS = 1;
const dstCache = new Map<number, [number, number]>();

function localOffsetMs(t: number): number {
  const year = new Date(t).getUTCFullYear();
  let range = dstCache.get(year);
  if (!range) {
    const lastSunday = (month: number) => {
      const d = new Date(Date.UTC(year, month + 1, 0, 1));
      d.setUTCDate(d.getUTCDate() - d.getUTCDay());
      return d.getTime();
    };
    range = [lastSunday(2), lastSunday(9)];
    dstCache.set(year, range);
  }
  return (STANDARD_OFFSET_HOURS + (t >= range[0] && t < range[1] ? 1 : 0)) * 3_600_000;
}

// "2026-10-04 18:30", local time.
export function localDateTime(iso: string): string {
  const t = Date.parse(iso);
  return new Date(t + localOffsetMs(t)).toISOString().slice(0, 16).replace("T", " ");
}
