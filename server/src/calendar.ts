// Calendar for the coach: when the user is busy in the next 14 days (times only,
// no titles), free slots and planned workouts; plus comparison of planned vs. actual
// workouts in the past 14 days. The data is sent by the app
// (POST /calendar), which reads the iPhone calendars.

import { addDays, formatDay, isoSeconds, localDateTime, localMidnightUtc } from "./time";

export const DAYS_AHEAD = 14;

// Free slots between 06:30 and 22:00, at least 45 minutes.
const FREE_FROM_MIN = 6 * 60 + 30;
const FREE_TO_MIN = 22 * 60;
const MIN_FREE_MIN = 45;
const MINUTE = 60_000;

export interface CalendarRow {
  kind: "busy" | "planned";
  start_at: string;
  end_at: string;
  all_day: number;
  title: string | null;
  notes: string | null;
}

export interface CalendarDay {
  day: string;
  allDay: boolean;
  busy: string[];
  free: string[];
  planned: string[];
}

export interface PlanCheck {
  day: string;
  time: string;
  title: string;
  done: string | null;
}

export interface CalendarInfo {
  updatedAt: string | null;
  days: CalendarDay[];
  checks: PlanCheck[];
}

const REPLACE = [
  "DELETE FROM calendar_events WHERE end_at >= json_extract(?1, '$.from')",
  `INSERT INTO calendar_events (kind, start_at, end_at, all_day)
   SELECT 'busy', json_extract(value, '$.start'), json_extract(value, '$.end'), coalesce(json_extract(value, '$.allDay'), 0)
   FROM json_each(?1, '$.busy')`,
  `INSERT INTO calendar_events (kind, start_at, end_at, all_day, title, notes)
   SELECT 'planned', json_extract(value, '$.start'), json_extract(value, '$.end'), 0,
          substr(json_extract(value, '$.title'), 1, 200), substr(json_extract(value, '$.notes'), 1, 1000)
   FROM json_each(?1, '$.planned')`,
];

// Like /ingest: the body is passed whole to D1, which decomposes it using JSON functions.
export async function receiveCalendar(db: D1Database, body: string): Promise<Response> {
  const results = await db.batch([
    ...REPLACE.map((sql) => db.prepare(sql).bind(body)),
    db.prepare("INSERT OR REPLACE INTO calendar_sync (id, received_at) VALUES (1, ?1)").bind(isoSeconds(new Date())),
  ]);
  return Response.json({ busy: results[1].meta.changes, planned: results[2].meta.changes });
}

export function calendarQueries(db: D1Database, today: string): D1PreparedStatement[] {
  return [
    db.prepare("SELECT kind, start_at, end_at, all_day, title, notes FROM calendar_events WHERE end_at >= ?1 AND start_at < ?2 ORDER BY start_at")
      .bind(localMidnightUtc(addDays(today, -DAYS_AHEAD)), localMidnightUtc(addDays(today, DAYS_AHEAD))),
    db.prepare("SELECT received_at FROM calendar_sync WHERE id = 1"),
  ];
}

interface WorkoutLike { start: string; activity: string; minutes: number }

export function computeCalendar(rows: CalendarRow[], updatedAt: string | null, today: string, now: Date, workouts: WorkoutLike[]): CalendarInfo {
  const days: CalendarDay[] = [];
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const day = addDays(today, i);
    const start = Date.parse(localMidnightUtc(day));
    const end = Date.parse(localMidnightUtc(addDays(day, 1)));
    const onDay = rows.filter((r) => Date.parse(r.start_at) < end && Date.parse(r.end_at) > start);
    const busy = onDay.filter((r) => r.kind === "busy");
    const allDay = busy.some((r) => r.all_day);
    // Busy intervals in minutes from local midnight, merged when they overlap.
    const intervals = merge(busy.filter((r) => !r.all_day).map((r) => [
      Math.max(0, (Date.parse(r.start_at) - start) / MINUTE),
      Math.min((end - start) / MINUTE, (Date.parse(r.end_at) - start) / MINUTE),
    ] as [number, number]));
    // Today, free slots start from now.
    const fromNow = i === 0 ? Math.max(FREE_FROM_MIN, Math.ceil((now.getTime() - start) / MINUTE / 15) * 15) : FREE_FROM_MIN;
    days.push({
      day,
      allDay,
      busy: intervals.map(([a, b]) => `${clock(a)}-${clock(b)}`),
      free: allDay ? [] : freeSlots(intervals, fromNow, FREE_TO_MIN).map(([a, b]) => `${clock(a)}-${clock(b)}`),
      planned: onDay.filter((r) => r.kind === "planned").map((r) =>
        `${localDateTime(r.start_at).slice(11)} ${r.title ?? "workout"} (${Math.round((Date.parse(r.end_at) - Date.parse(r.start_at)) / MINUTE)} min)`),
    });
  }

  // Planned in past days: done if there is a workout the same day, within 3 hours.
  const checks = rows
    .filter((r) => r.kind === "planned" && Date.parse(r.end_at) < now.getTime())
    .map((r) => {
      const planned = Date.parse(r.start_at);
      const day = localDateTime(r.start_at).slice(0, 10);
      const match = workouts.find((w) =>
        localDateTime(w.start).slice(0, 10) === day && Math.abs(Date.parse(w.start) - planned) <= 3 * 60 * MINUTE);
      return {
        day,
        time: localDateTime(r.start_at).slice(11),
        title: r.title ?? "workout",
        done: match ? `${match.activity}, ${match.minutes} min` : null,
      };
    });
  return { updatedAt, days, checks };
}

export function renderCalendar(c: CalendarInfo): string[] {
  if (!c.updatedAt) {
    return ["", "Calendar: not yet connected from the iPhone, so I don't know when you are busy."];
  }
  const lines = [
    "",
    `Calendar, next ${DAYS_AHEAD} days (from the iPhone, updated ${localDateTime(c.updatedAt).slice(11)} on ${formatDay(localDateTime(c.updatedAt).slice(0, 10))}). Times only, without appointment titles. Free: slots of at least ${MIN_FREE_MIN} minutes between 06:30 and 22:00:`,
  ];
  for (const d of c.days) {
    const parts = [
      d.allDay ? "busy all day" : d.busy.length ? `busy ${d.busy.join(", ")}` : "no commitments",
      d.free.length ? `free ${d.free.join(", ")}` : null,
      d.planned.length ? `planned workouts: ${d.planned.join(", ")}` : null,
    ].filter(Boolean);
    lines.push(`* ${formatDay(d.day)}: ${parts.join("; ")}`);
  }
  if (c.checks.length) {
    lines.push("", `Planned workouts in the last ${DAYS_AHEAD} days, and if they were done:`);
    for (const p of c.checks) {
      lines.push(`* ${formatDay(p.day)} ${p.time} ${p.title}: ${p.done ? `done (${p.done})` : "not done"}`);
    }
  }
  return lines;
}

function merge(intervals: [number, number][]): [number, number][] {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function freeSlots(busy: [number, number][], from: number, to: number): [number, number][] {
  const slots: [number, number][] = [];
  let cursor = from;
  for (const [a, b] of busy) {
    if (a - cursor >= MIN_FREE_MIN && a > cursor) slots.push([cursor, Math.min(a, to)]);
    cursor = Math.max(cursor, b);
    if (cursor >= to) break;
  }
  if (to - cursor >= MIN_FREE_MIN) slots.push([cursor, to]);
  return slots.filter(([a, b]) => b - a >= MIN_FREE_MIN);
}

function clock(minutes: number): string {
  const m = Math.round(minutes);
  if (m >= 24 * 60) return "24:00";
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
