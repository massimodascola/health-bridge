// Data exports, all behind the same token as the coach link (/data/<token>/...):
// * daily.csv: one day per row, all daily metrics;
// * workouts.csv: all workouts;
// * workouts.ics and sleep.ics: calendars to subscribe to (Calendar on iPhone and Mac);
// * latest.json: the latest values, flat, for Home Assistant and the widget;
// * gpx/<uuid>: the GPS route of a workout.
// SQLite builds the heavy rows: the free Worker has 10 ms of CPU.

import { ACTIVITY_NAMES } from "./activities";
import { ROUTE, gpx, parsePoints } from "./routes";
import { TIME_ZONE, addDays, isoSeconds, localDateTime, localDay, localMidnightUtc } from "./time";

const WORKOUT = "HKWorkoutTypeIdentifier";
const SLEEP = "HKCategoryTypeIdentifierSleepAnalysis";
const Q = "HKQuantityTypeIdentifier";

// Daily CSV columns: metric of the daily table, header, divisor, decimals.
export const DAILY_COLUMNS: [metric: string, header: string, divisor: number, decimals: number][] = [
  ["steps", "steps", 1, 0],
  ["activeEnergy", "active_energy_kcal", 1, 0],
  ["basalEnergy", "basal_energy_kcal", 1, 0],
  ["exerciseTime", "exercise_min", 1, 0],
  ["standTime", "stand_min", 1, 0],
  ["distance", "distance_km", 1000, 2],
  ["flights", "floors", 1, 0],
  ["daylight", "daylight_min", 1, 0],
  ["cyclingDistance", "cycling_km", 1000, 2],
  ["swimmingDistance", "swimming_m", 1, 0],
  ["sleep", "sleep_min", 1, 0],
  ["sleepDeep", "deep_sleep_min", 1, 0],
  ["sleepRem", "rem_sleep_min", 1, 0],
  ["restingHr", "resting_hr_bpm", 1, 1],
  ["walkingHr", "walking_hr_bpm", 1, 1],
  ["hrv", "hrv_sdnn_ms", 1, 1],
  ["hrvRmssd", "hrv_rmssd_ms", 1, 1],
  ["respiratoryRate", "breaths_min", 1, 1],
  ["oxygen", "oxygen_pct", 1, 1],
  ["vo2Max", "vo2max", 1, 1],
  ["bodyMass", "weight_kg", 1, 1],
  ["bodyFat", "body_fat_pct", 1, 1],
  ["water", "water_l", 1000, 2],
];

// Value of a metric in the day row. Metrics are code constants, they never come
// from outside: they can be written into the query.
function cells(): string[] {
  return DAILY_COLUMNS.map(([metric, , divisor, decimals]) => {
    const value = `max(CASE WHEN metric = '${metric}' THEN value END) / ${divisor}.0`;
    return decimals ? `round(${value}, ${decimals})` : `CAST(round(${value}) AS INTEGER)`;
  });
}

export async function dailyCsv(db: D1Database): Promise<string> {
  const line = cells().map((c) => `coalesce(${c}, '')`).join(" || ',' || ");
  const row = await db.prepare(`SELECT group_concat(line, char(10)) AS csv FROM (
      SELECT day || ',' || ${line} AS line FROM daily GROUP BY day ORDER BY day)`).first<{ csv: string | null }>();
  const header = ["date", ...DAILY_COLUMNS.map(([, h]) => h)].join(",");
  return `${header}\n${row?.csv ?? ""}\n`;
}

// Daily series for the charts: [day, ...values in DAILY_COLUMNS order], already
// JSON. json() gives each row back its JSON type, which the subquery loses.
export async function dailySeries(db: D1Database): Promise<string> {
  const row = await db.prepare(`SELECT json_group_array(json(r)) AS data FROM (
      SELECT json_array(day, ${cells().join(", ")}) AS r FROM daily GROUP BY day ORDER BY day)`).first<{ data: string | null }>();
  return row?.data ?? "[]";
}

interface WorkoutLine {
  uuid: string;
  start_at: string;
  end_at: string;
  seconds: number;
  activity: number | null;
  kcal: number | null;
  meters: number | null;
  indoor: number | null;
  hr_avg: number | null;
  hr_max: number | null;
  source: string | null;
  has_route: number;
}

// Only the fields needed, extracted by SQLite: the full metadata weighs 1-2 KB each.
export async function workoutLines(db: D1Database, since = "0000", limit = 100_000): Promise<WorkoutLine[]> {
  const { results } = await db.prepare(`SELECT uuid, start_at, end_at, value AS seconds,
      json_extract(meta, '$.activityType') AS activity, json_extract(meta, '$.energyKcal') AS kcal,
      json_extract(meta, '$.distanceM') AS meters, json_extract(meta, '$.indoor') AS indoor,
      json_extract(meta, '$.stats.${Q}HeartRate.avg') AS hr_avg,
      json_extract(meta, '$.stats.${Q}HeartRate.max') AS hr_max, source,
      EXISTS (SELECT 1 FROM samples r WHERE r.type = ?2
        AND r.start_at >= strftime('%Y-%m-%dT%H:%M:%SZ', w.start_at, '-60 seconds')
        AND r.start_at <= strftime('%Y-%m-%dT%H:%M:%SZ', w.end_at, '+60 seconds')) AS has_route
    FROM samples w WHERE type = ?1 AND start_at >= ?3 ORDER BY start_at DESC LIMIT ?4`)
    .bind(WORKOUT, ROUTE, since, limit).all<WorkoutLine>();
  return results;
}

export function activityName(type: number | null): string {
  return ACTIVITY_NAMES[type ?? 3000] ?? `activity ${type}`;
}

export async function workoutsCsv(db: D1Database): Promise<string> {
  const rows = await workoutLines(db);
  const lines = ["start,end,activity,minutes,km,kcal,hr_avg,hr_max,indoor,source,gps"];
  for (const w of rows.reverse()) {
    lines.push([
      localDateTime(w.start_at), localDateTime(w.end_at), activityName(w.activity),
      Math.round(w.seconds / 60), round(w.meters ? w.meters / 1000 : null, 2), round(w.kcal, 0),
      round(w.hr_avg, 0), round(w.hr_max, 0), w.indoor === null ? "" : w.indoor ? "yes" : "no",
      csvText(w.source ?? ""), w.has_route ? "yes" : "no",
    ].join(","));
  }
  return `${lines.join("\n")}\n`;
}

export async function workoutsIcs(db: D1Database, now: Date): Promise<string> {
  const rows = await workoutLines(db, `${addDays(localDay(now), -730)}T00:00:00Z`);
  const events = rows.map((w) => {
    const km = w.meters && w.meters > 100 ? `${(w.meters / 1000).toFixed(1)} km` : null;
    const title = [capitalize(activityName(w.activity)), km, `${Math.round(w.seconds / 60)} min`].filter(Boolean).join(" · ");
    const details = [
      w.kcal && `${Math.round(w.kcal)} kcal`,
      w.hr_avg && `HR avg ${Math.round(w.hr_avg)}${w.hr_max ? `, max ${Math.round(w.hr_max)}` : ""}`,
      w.source && `Recorded by ${w.source}`,
    ].filter(Boolean).join("\n");
    return vevent(`workout-${w.uuid}`, w.start_at, w.end_at, title, details, now);
  });
  return calendar("Workouts", events);
}

interface SleepSample { start_at: string; end_at: string; value: number }

// One night per event, from falling asleep to waking up, last 90 days.
export async function sleepIcs(db: D1Database, now: Date): Promise<string> {
  const { results } = await db.prepare(`SELECT start_at, end_at, value FROM samples
      WHERE type = ?1 AND end_at >= ?2 AND value IN (1, 2, 3, 4, 5)`)
    .bind(SLEEP, `${addDays(localDay(now), -90)}T00:00:00Z`).all<SleepSample>();
  const nights = new Map<string, { start: string; end: string; asleep: number; deep: number; rem: number; awake: number }>();
  for (const s of results) {
    // Same rule as the summary: a night takes the date of waking up (end + 6 hours).
    const night = localDateTime(isoSeconds(new Date(Date.parse(s.end_at) + 6 * 3_600_000))).slice(0, 10);
    const n = nights.get(night) ?? { start: s.start_at, end: s.end_at, asleep: 0, deep: 0, rem: 0, awake: 0 };
    const minutes = (Date.parse(s.end_at) - Date.parse(s.start_at)) / 60_000;
    if (s.value === 2) n.awake += minutes;
    else {
      n.asleep += minutes;
      if (s.value === 4) n.deep += minutes;
      if (s.value === 5) n.rem += minutes;
      if (s.start_at < n.start) n.start = s.start_at;
      if (s.end_at > n.end) n.end = s.end_at;
    }
    nights.set(night, n);
  }
  const events = [...nights.entries()].filter(([, n]) => n.asleep >= 60).map(([night, n]) =>
    vevent(`sleep-${night}`, n.start, n.end, `Sleep ${hours(n.asleep)}`,
      `Deep ${hours(n.deep)}, REM ${hours(n.rem)}, awake ${hours(n.awake)}`, now));
  return calendar("Sleep", events);
}

// Latest values, flat: handy for Home Assistant REST sensors.
export async function latest(db: D1Database, now: Date) {
  const today = localDay(now);
  const [ingest, coach, daily, vitals, sleep, workout, weight, waterGoal] = await db.batch([
    db.prepare("SELECT received_at AS at FROM ingests ORDER BY id DESC LIMIT 1"),
    db.prepare("SELECT read_at AS at FROM summary_reads WHERE client = 'link' AND user_agent LIKE '%ChatGPT-User%' ORDER BY id DESC LIMIT 1"),
    db.prepare("SELECT metric, value FROM daily WHERE day = ?1").bind(today),
    db.prepare(`SELECT type, max(start_at) AS at, value FROM samples WHERE type IN (?1, ?2, ?3, ?4, ?5) GROUP BY type`)
      .bind(`${Q}RestingHeartRate`, `${Q}HeartRateVariabilitySDNN`, `${Q}HeartRateVariabilityRMSSD`, `${Q}VO2Max`, `${Q}BodyMass`),
    db.prepare("SELECT start_at, end_at, value FROM samples WHERE type = ?1 AND end_at >= ?2 AND value IN (1, 2, 3, 4, 5)")
      .bind(SLEEP, isoSeconds(new Date(Date.parse(localMidnightUtc(today)) - 12 * 3_600_000))),
    db.prepare(`SELECT start_at, value AS seconds, json_extract(meta, '$.activityType') AS activity,
        json_extract(meta, '$.distanceM') AS meters FROM samples WHERE type = ?1 ORDER BY start_at DESC LIMIT 1`).bind(WORKOUT),
    // Weight measured before the app was installed is only in the daily history.
    db.prepare("SELECT value FROM daily WHERE metric = 'bodyMass' ORDER BY day DESC LIMIT 1"),
    db.prepare("SELECT value FROM profile WHERE key = 'waterGoalMl'"),
  ]);
  const day = new Map((daily.results as { metric: string; value: number }[]).map((r) => [r.metric, r.value]));
  const vital = new Map((vitals.results as { type: string; at: string; value: number }[]).map((r) => [r.type.replace(Q, ""), r]));
  let asleep = 0, deep = 0, rem = 0;
  let bedtime: string | null = null, wake: string | null = null;
  for (const s of sleep.results as unknown as SleepSample[]) {
    if (s.value === 2) continue;
    const minutes = (Date.parse(s.end_at) - Date.parse(s.start_at)) / 60_000;
    asleep += minutes;
    if (s.value === 4) deep += minutes;
    if (s.value === 5) rem += minutes;
    if (!bedtime || s.start_at < bedtime) bedtime = s.start_at;
    if (!wake || s.end_at > wake) wake = s.end_at;
  }
  const w = workout.results[0] as { start_at: string; seconds: number; activity: number | null; meters: number | null } | undefined;
  const at = (name: string) => vital.get(name)?.value ?? null;
  return {
    updated_at: (ingest.results[0] as { at: string } | undefined)?.at ?? null,
    coach_last_read: (coach.results[0] as { at: string } | undefined)?.at ?? null,
    sleep_minutes: asleep ? Math.round(asleep) : null,
    sleep_deep_minutes: asleep ? Math.round(deep) : null,
    sleep_rem_minutes: asleep ? Math.round(rem) : null,
    bedtime,
    wake_time: wake,
    resting_hr: round(at("RestingHeartRate"), 0),
    hrv_ms: round(at("HeartRateVariabilitySDNN"), 0),
    hrv_rmssd_ms: round(at("HeartRateVariabilityRMSSD"), 0),
    vo2_max: round(at("VO2Max"), 1),
    weight_kg: round(at("BodyMass") ?? (weight.results[0] as { value: number } | undefined)?.value ?? null, 1),
    steps_today: round(day.get("steps") ?? null, 0),
    active_energy_today: round(day.get("activeEnergy") ?? null, 0),
    exercise_minutes_today: round(day.get("exerciseTime") ?? null, 0),
    distance_km_today: round(day.has("distance") ? day.get("distance")! / 1000 : null, 2),
    water_today_ml: round(day.get("water") ?? null, 0),
    water_goal_ml: Number((waterGoal.results[0] as { value: string } | undefined)?.value) || null,
    last_workout: w ? activityName(w.activity) : null,
    last_workout_start: w?.start_at ?? null,
    last_workout_minutes: w ? Math.round(w.seconds / 60) : null,
    last_workout_km: w?.meters ? round(w.meters / 1000, 2) : null,
  };
}

export async function workoutGpx(db: D1Database, uuid: string): Promise<string | null> {
  const workout = await db.prepare(`SELECT start_at, end_at, json_extract(meta, '$.activityType') AS activity
      FROM samples WHERE uuid = ?1 AND type = ?2`).bind(uuid, WORKOUT)
    .first<{ start_at: string; end_at: string; activity: number | null }>();
  if (!workout) return null;
  const route = await db.prepare(`SELECT start_at, meta FROM samples WHERE type = ?1
      AND start_at >= ?2 AND start_at <= ?3 ORDER BY start_at LIMIT 1`)
    .bind(ROUTE, isoSeconds(new Date(Date.parse(workout.start_at) - 60_000)), isoSeconds(new Date(Date.parse(workout.end_at) + 60_000)))
    .first<{ start_at: string; meta: string | null }>();
  if (!route) return null;
  const name = `${capitalize(activityName(workout.activity))} ${localDateTime(workout.start_at)}`;
  return gpx(name, route.start_at, parsePoints(route.meta));
}

function calendar(name: string, events: string[]): string {
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//HealthBridge//EN", "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${name}`, `X-WR-TIMEZONE:${TIME_ZONE}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H",
    ...events, "END:VCALENDAR", "",
  ].join("\r\n");
}

function vevent(uid: string, start: string, end: string, title: string, details: string, now: Date): string {
  return [
    "BEGIN:VEVENT", `UID:${uid}@healthbridge`, `DTSTAMP:${icsDate(isoSeconds(now))}`,
    `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsText(title)}`, `DESCRIPTION:${icsText(details)}`, "TRANSP:TRANSPARENT", "END:VEVENT",
  ].join("\r\n");
}

// 2026-10-04T14:11:00Z -> 20261004T141100Z
function icsDate(iso: string): string {
  return iso.replace(/[-:]/g, "");
}

function icsText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/([,;])/g, "\\$1").replace(/\n/g, "\\n");
}

function csvText(text: string): string {
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function round(value: number | null, decimals: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function hours(minutes: number): string {
  const total = Math.round(minutes);
  return total >= 60 ? `${Math.floor(total / 60)} h ${total % 60} min` : `${total} min`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
