// Summary for the coach: period averages compared with the previous period,
// day by day and workouts. All computed from data in D1.

import { ACTIVITY_NAMES } from "./activities";
import { MEASURES, NUTRIENTS } from "./catalog";
import { categoryLabels, shows, type Category, type Show } from "./categories";
import {
  AVERAGED_EXTRAS, DAILY_SUM_EXTRAS, EXTRA_TYPES, computeExtras, renderExtras, workoutDetails,
  type ExtraRow, type Extras, type LastRow, type MeasureRow, type NutrientRow,
} from "./extras";
import { calendarQueries, computeCalendar, renderCalendar, type CalendarInfo, type CalendarRow } from "./calendar";
import { buildHistory, renderHistory, type History } from "./history";
import { computeTraining, renderTraining, trainingQueries, type TrainingLog, type TrainingRow } from "./training";
import { ROUTE, describeSplits, pace, parsePoints, routeFor, routeStats, type RouteRow } from "./routes";
import { TIME_ZONE, addDays, dayRange, formatDateTime, formatDateTimeSeconds, formatDay, formatTime, isoSeconds, localDay, localMidnightUtc } from "./time";

const HEART_RATE = "HKQuantityTypeIdentifierHeartRate";
const RESTING_HR = "HKQuantityTypeIdentifierRestingHeartRate";
const HRV = "HKQuantityTypeIdentifierHeartRateVariabilitySDNN";
const SLEEP = "HKCategoryTypeIdentifierSleepAnalysis";
const WORKOUT = "HKWorkoutTypeIdentifier";

// HKCategoryValueSleepAnalysis values that count as actual sleep:
// 1 unspecified, 3 core, 4 deep, 5 REM. Excluded are 0 (in bed) and 2 (awake).
const ASLEEP = new Set([1, 3, 4, 5]);
const AWAKE = 2;
const CORE = 3;
const DEEP = 4;
const REM = 5;

// Free D1: max 50 queries and 100 parameters per query. Heart rate for
// all workouts is read with a single query: 3 parameters per workout plus one.
const MAX_WORKOUTS = 30;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// For each workout (start, end, middle): average, max, and average of each half.
function hrDuring(db: D1Database, workouts: WorkoutRow[]): D1PreparedStatement {
  const windows = workouts.map((_, i) => `(${i}, ?${i * 3 + 2}, ?${i * 3 + 3}, ?${i * 3 + 4})`).join(", ");
  const params = workouts.flatMap((w) => {
    const middle = new Date((Date.parse(w.start_at) + Date.parse(w.end_at)) / 2);
    return [w.start_at, w.end_at, isoSeconds(middle)];
  });
  return db.prepare(`WITH w(i, s, e, m) AS (VALUES ${windows})
    SELECT w.i AS i, count(*) AS n, avg(x.value) AS avg, max(x.value) AS max,
      avg(CASE WHEN x.start_at < w.m THEN x.value END) AS first_half,
      avg(CASE WHEN x.start_at >= w.m THEN x.value END) AS second_half
    FROM w JOIN samples x ON x.type = ?1 AND x.start_at >= w.s AND x.start_at <= w.e
    GROUP BY w.i`).bind(HEART_RATE, ...params);
}

const placeholders = (count: number, from: number) => Array.from({ length: count }, (_, i) => `?${i + from}`).join(", ");

export interface DayData {
  day: string;
  steps: number | null;
  activeEnergyKcal: number | null;
  exerciseMinutes: number | null;
  distanceKm: number | null;
  restingHr: number | null;
  hrvMs: number | null;
  sleepMinutes: number | null;
  deepMinutes: number | null;
  remMinutes: number | null;
  coreMinutes: number | null;
  awakeMinutes: number | null;
  awakenings: number;
  bedtime: string | null;
  wakeTime: string | null;
  waterLiters: number | null;
}

export interface WorkoutData {
  start: string;
  end: string;
  activity: string;
  minutes: number;
  indoor: boolean | null;
  energyKcal: number | null;
  distanceKm: number | null;
  hrSamples: number;
  avgHr: number | null;
  maxHr: number | null;
  driftPercent: number | null;
  effort: number | null;
  effortEstimated: boolean;
  hrRecoveryBpm: number | null;
  sport: string[];
  hasRoute: boolean;
}

export interface Averages {
  steps: number | null;
  activeEnergyKcal: number | null;
  exerciseMinutes: number | null;
  sleepMinutes: number | null;
  deepMinutes: number | null;
  remMinutes: number | null;
  restingHr: number | null;
  hrvMs: number | null;
}

export interface Summary {
  generatedAt: string;
  lastIngestAt: string | null;
  days: number;
  from: string;
  to: string;
  averages: Averages;
  previousAverages: Averages;
  perDay: DayData[];
  workouts: WorkoutData[];
  extras: Extras;
  // Absent when an automation doesn't request history: saves 8 queries.
  history: History | null;
  calendar: CalendarInfo;
  training: TrainingLog;
}

interface DailyRow { day: string; metric: string; value: number }
interface VitalRow { type: string; start_at: string; value: number }
interface SleepRow { start_at: string; end_at: string; value: number }
interface WorkoutRow { start_at: string; end_at: string; value: number; meta: string | null }
interface HrRow { i: number; n: number; avg: number | null; max: number | null; first_half: number | null; second_half: number | null }

export async function buildSummary(
  db: D1Database,
  days: number,
  now: Date,
  options: { categories?: Iterable<string> } = {},
): Promise<Summary> {
  const today = localDay(now);
  const period = dayRange(today, days);
  const previous = dayRange(addDays(today, -days), days);
  // One day margin on UTC: exact local date filter is done after.
  const since = `${addDays(previous[0], -1)}T00:00:00Z`;
  const periodSince = `${addDays(period[0], -1)}T00:00:00Z`;

  const extrasQuery = `SELECT type, start_at, end_at, value, meta FROM samples
    WHERE start_at >= ?1 AND type IN (${placeholders(EXTRA_TYPES.length, 2)})`;
  // Frequent samples, rarely measured values, and micronutrients: SQLite computes
  // averages and sums. Daily sums (micronutrients, daylight) count only full days,
  // today excluded; day is approximated with UTC+1, enough for meals and daylight.
  const periodStart = localMidnightUtc(period[0]);
  const todayStart = localMidnightUtc(today);
  const averaged = [...MEASURES.filter((m) => m.show !== "last").map((m) => m.type), ...AVERAGED_EXTRAS];
  const lastOnly = MEASURES.filter((m) => m.show === "last").map((m) => m.type);
  const nutrientTypes = [...NUTRIENTS.map((n) => n.type), ...DAILY_SUM_EXTRAS];

  const withHistory = shows(options.categories)("history");
  const historyPromise = withHistory ? buildHistory(db, today) : Promise.resolve(null);
  const [dailyRes, vitalsRes, sleepRes, workoutsRes, ingestRes, extrasRes, measuresRes, lastRes, nutrientsRes, routesRes, calendarRes, calendarSyncRes, waterGoalRes, trainingRes, lastLoadsRes] = await db.batch([
    db.prepare("SELECT day, metric, value FROM daily WHERE day >= ?1 AND day <= ?2")
      .bind(previous[0], today),
    db.prepare("SELECT type, start_at, value FROM samples WHERE type IN (?1, ?2) AND start_at >= ?3")
      .bind(RESTING_HR, HRV, since),
    db.prepare("SELECT start_at, end_at, value FROM samples WHERE type = ?1 AND end_at >= ?2")
      .bind(SLEEP, since),
    db.prepare("SELECT start_at, end_at, value, meta FROM samples WHERE type = ?1 AND start_at >= ?2 ORDER BY start_at")
      .bind(WORKOUT, periodSince),
    db.prepare("SELECT received_at AS last FROM ingests ORDER BY id DESC LIMIT 1"),
    db.prepare(extrasQuery).bind(since, ...EXTRA_TYPES),
    db.prepare(`SELECT type, count(*) AS n, avg(value) AS avg, sum(value) AS sum FROM samples
      WHERE start_at >= ?1 AND type IN (${placeholders(averaged.length, 2)}) GROUP BY type`)
      .bind(periodStart, ...averaged),
    // With a single max(), SQLite takes "value" from the same row: the latest value.
    db.prepare(`SELECT type, max(start_at) AS at, value FROM samples
      WHERE type IN (${placeholders(lastOnly.length, 1)}) GROUP BY type`).bind(...lastOnly),
    db.prepare(`SELECT type, sum(value) AS total, count(DISTINCT date(start_at, '+1 hours')) AS days FROM samples
      WHERE start_at >= ?1 AND start_at < ?2 AND type IN (${placeholders(nutrientTypes.length, 3)}) GROUP BY type`)
      .bind(periodStart, todayStart, ...nutrientTypes),
    db.prepare("SELECT start_at, end_at, meta FROM samples WHERE type = ?1 AND start_at >= ?2")
      .bind(ROUTE, periodSince),
    ...calendarQueries(db, today),
    db.prepare("SELECT value FROM profile WHERE key = 'waterGoalMl'"),
    ...trainingQueries(db, periodSince),
  ]);
  const extraRows = extrasRes.results as unknown as ExtraRow[];
  const routes = routesRes.results as unknown as RouteRow[];

  const byDay = new Map<string, DayData>();
  for (const day of [...previous, ...period]) byDay.set(day, emptyDay(day));

  for (const row of dailyRes.results as unknown as DailyRow[]) {
    const data = byDay.get(row.day);
    if (!data) continue;
    if (row.metric === "steps") data.steps = row.value;
    if (row.metric === "activeEnergy") data.activeEnergyKcal = row.value;
    if (row.metric === "exerciseTime") data.exerciseMinutes = row.value;
    if (row.metric === "distance") data.distanceKm = row.value / 1000;
    if (row.metric === "water") data.waterLiters = row.value / 1000;
  }

  const resting = new Map<string, number[]>();
  const hrv = new Map<string, number[]>();
  for (const row of vitalsRes.results as unknown as VitalRow[]) {
    push(row.type === RESTING_HR ? resting : hrv, localDay(new Date(row.start_at)), row.value);
  }
  for (const [day, values] of resting) {
    const data = byDay.get(day);
    if (data) data.restingHr = mean(values);
  }
  for (const [day, values] of hrv) {
    const data = byDay.get(day);
    if (data) data.hrvMs = mean(values);
  }

  for (const row of sleepRes.results as unknown as SleepRow[]) {
    if (!ASLEEP.has(row.value) && row.value !== AWAKE) continue;
    const start = Date.parse(row.start_at);
    const end = Date.parse(row.end_at);
    // Night takes the wake date: shifting end by 6 hours, sleep started
    // before midnight and afternoon naps count on the same day.
    const data = byDay.get(localDay(new Date(end + 6 * HOUR)));
    if (!data) continue;
    const minutes = (end - start) / MINUTE;
    if (row.value === AWAKE) {
      data.awakeMinutes = (data.awakeMinutes ?? 0) + minutes;
      data.awakenings += 1;
      continue;
    }
    data.sleepMinutes = (data.sleepMinutes ?? 0) + minutes;
    if (row.value === DEEP) data.deepMinutes = (data.deepMinutes ?? 0) + minutes;
    if (row.value === REM) data.remMinutes = (data.remMinutes ?? 0) + minutes;
    if (row.value === CORE) data.coreMinutes = (data.coreMinutes ?? 0) + minutes;
    if (!data.bedtime || row.start_at < data.bedtime) data.bedtime = row.start_at;
    if (!data.wakeTime || row.end_at > data.wakeTime) data.wakeTime = row.end_at;
  }

  const periodWorkouts = (workoutsRes.results as unknown as WorkoutRow[])
    .filter((w) => period.includes(localDay(new Date(w.start_at))))
    .slice(-MAX_WORKOUTS);
  const hrRows = periodWorkouts.length
    ? (await hrDuring(db, periodWorkouts).all()).results as unknown as HrRow[]
    : [];
  const workouts = periodWorkouts.map((w, i) =>
    describeWorkout(w, hrRows.find((r) => r.i === i) ?? null, extraRows, routeFor(routes, w.start_at, w.end_at)));

  const perDayPrevious = previous.map((day) => byDay.get(day)!);
  const perDay = period.map((day) => byDay.get(day)!);
  const extras = computeExtras(extraRows, period, today, {
    measures: measuresRes.results as unknown as MeasureRow[],
    last: lastRes.results as unknown as LastRow[],
    nutrients: nutrientsRes.results as unknown as NutrientRow[],
  });
  // Water: goal from app (profile), full days logged and how many met it.
  const goalMl = Number((waterGoalRes.results[0] as { value: string } | undefined)?.value) || null;
  const logged = perDay.filter((d) => d.day !== today && d.waterLiters !== null);
  extras.lifestyle.water = {
    goalLiters: goalMl ? goalMl / 1000 : null,
    todayLiters: byDay.get(today)?.waterLiters ?? null,
    metDays: goalMl ? logged.filter((d) => d.waterLiters! * 1000 >= goalMl).length : 0,
    loggedDays: logged.length,
  };
  const last = (ingestRes.results[0] as { last: string | null } | undefined)?.last ?? null;

  return {
    generatedAt: now.toISOString(),
    lastIngestAt: last,
    days,
    from: period[0],
    to: today,
    averages: averages(perDay, today),
    previousAverages: averages(perDayPrevious, today),
    perDay,
    workouts,
    extras,
    history: await historyPromise,
    calendar: computeCalendar(
      calendarRes.results as unknown as CalendarRow[],
      (calendarSyncRes.results[0] as { received_at: string } | undefined)?.received_at ?? null,
      today, now, workouts.map((w) => ({ start: w.start, activity: w.activity, minutes: w.minutes })),
    ),
    training: computeTraining(
      trainingRes.results as unknown as TrainingRow[],
      lastLoadsRes.results as unknown as (TrainingRow & { logged_at: string; best_kg: number | null })[],
    ),
  };
}

// Without categories (main coach link, app) everything is included. With categories
// from an automation only rows belonging to those categories remain.
export function renderSummary(s: Summary, categories?: Set<string>): string {
  const show = shows(categories);
  const a = s.averages;
  const p = s.previousAverages;
  // First line says when the page was generated, to the second. On 2026-10-10 the
  // coach opened the new page but replied with data from a copy from the evening
  // before, still in the same conversation: this way copies are distinguishable.
  const generated = formatDateTimeSeconds(new Date(s.generatedAt));
  const lines = [
    `Page generated: ${generated} (${TIME_ZONE}). If there are previous copies of this page in this conversation, they are old: only this page's data counts.`,
    `Apple Health data, last ${s.days} days: from ${formatDay(s.from)} to ${formatDay(s.to)} (today, in progress).`,
    s.lastIngestAt
      ? `Last upload from phone: ${formatDateTime(new Date(s.lastIngestAt))}.`
      : "No upload from phone yet.",
  ];
  const tonight = s.perDay[s.perDay.length - 1];
  if (show("sleep") && tonight && tonight.sleepMinutes === null) {
    lines.push("Last night's sleep: not arrived yet. The Watch sends it to iPhone on wake and iPhone sends it as soon as it can: doesn't mean there was no sleep.");
  }
  if (categories) {
    lines.push(`This page contains only: ${categoryLabels(categories)}. Other Health data is left out on purpose: it is not missing.`);
  }
  const averages = ([
    ["activity", `* Steps: ${num(a.steps)} per day (${num(p.steps)})`],
    ["activity", `* Active energy: ${num(a.activeEnergyKcal, "kcal")} per day (${num(p.activeEnergyKcal, "kcal")})`],
    ["activity", `* Exercise: ${num(a.exerciseMinutes, "min")} per day (${num(p.exerciseMinutes, "min")})`],
    ["sleep", `* Sleep: ${duration(a.sleepMinutes)} per night (${duration(p.sleepMinutes)}), of which deep ${duration(a.deepMinutes)} and REM ${duration(a.remMinutes)}`],
    ["heart", `* Resting HR: ${num(a.restingHr, "bpm")} (${num(p.restingHr, "bpm")})`],
    ["heart", `* HRV (SDNN): ${num(a.hrvMs, "ms")} (${num(p.hrvMs, "ms")})`],
  ] as [Category, string][]).filter(([category]) => show(category)).map(([, line]) => line);
  if (averages.length) {
    const partial = show("activity") ? ". Steps, energy and exercise exclude today, which is partial" : "";
    lines.push("", `Period averages, in parentheses the previous ${s.days} days${partial}:`, ...averages);
  }
  lines.push(...renderExtras(s.extras, show));
  const hasWater = s.perDay.some((d) => d.waterLiters !== null);
  const perDay = s.perDay.map((d) => {
    const parts = ([
      ["activity", `steps ${num(d.steps)}`],
      ["activity", `active energy ${num(d.activeEnergyKcal, "kcal")}`],
      ["activity", `exercise ${num(d.exerciseMinutes, "min")}`],
      ["sleep", `sleep ${sleepDetail(d)}`],
      ["heart", `resting HR ${num(d.restingHr, "bpm")}`],
      ["heart", `HRV ${num(d.hrvMs, "ms")}`],
      ...(hasWater ? [["nutrition", `water ${d.waterLiters === null ? "n/a" : `${decimal(d.waterLiters)} L`}`]] : []),
    ] as [Category, string][]).filter(([category]) => show(category)).map(([, part]) => part);
    return parts.length ? `* ${formatDay(d.day)}: ${parts.join(", ")}` : null;
  }).filter((line): line is string => line !== null);
  if (perDay.length) {
    // A day's sleep is the night ending that day: said with a real example,
    // because "Mar 6" alone reads easily as the night between 6 and 7.
    const last = s.perDay[s.perDay.length - 1].day;
    const night = show("sleep") ? ` (each day's sleep is the night ending that day: ${formatDay(last)} = night between ${formatDay(addDays(last, -1))} and ${formatDay(last)})` : "";
    lines.push("", `Day by day${night}:`, ...perDay);
  }
  if (show("workouts")) lines.push("", ...renderWorkouts(s), ...renderTraining(s.training));
  if (show("calendar")) lines.push(...renderCalendar(s.calendar));
  if (s.history && show("history")) lines.push(...renderHistory(s.history, show));
  return lines.join("\n");
}

function renderWorkouts(s: Summary): string[] {
  const lines: string[] = [];
  if (!s.workouts.length) {
    lines.push("Workouts: none in the period.");
  } else {
    lines.push(`Workouts (${s.workouts.length}):`);
    for (const w of s.workouts) {
      const start = new Date(w.start);
      const parts = [`${w.activity}${w.indoor ? " indoors" : ""}`, `${w.minutes} min`];
      if (w.energyKcal !== null) parts.push(num(w.energyKcal, "kcal"));
      if (w.distanceKm) parts.push(`${decimal(w.distanceKm)} km`);
      if (w.avgHr !== null) parts.push(`avg HR ${num(w.avgHr, "bpm")}, max ${num(w.maxHr, "bpm")}`);
      if (w.driftPercent !== null) {
        const sign = w.driftPercent > 0 ? "+" : "";
        parts.push(`cardiac drift ${sign}${w.driftPercent}% (second half vs first)`);
      }
      if (w.effort !== null) parts.push(`effort ${num(w.effort)}/10${w.effortEstimated ? " (estimated by Watch)" : ""}`);
      if (w.hrRecoveryBpm !== null) parts.push(`1-min HR recovery ${num(w.hrRecoveryBpm, "bpm")}`);
      parts.push(...w.sport);
      lines.push(`* ${formatDay(localDay(start))}, ${formatTime(start)}: ${parts.join(", ")}`);
    }
  }
  return lines;
}

// JSON version for automations: same data, only chosen categories, plus text.
const DAY_FIELDS: Record<string, Category> = {
  steps: "activity", activeEnergyKcal: "activity", exerciseMinutes: "activity", distanceKm: "activity",
  restingHr: "heart", hrvMs: "heart",
  sleepMinutes: "sleep", deepMinutes: "sleep", remMinutes: "sleep", coreMinutes: "sleep",
  awakeMinutes: "sleep", awakenings: "sleep", bedtime: "sleep", wakeTime: "sleep",
  waterLiters: "nutrition",
};
const HEALTH_FIELDS: Record<string, Category> = {
  respiratoryRate: "heart", oxygenPercent: "heart", breathingDisturbances: "sleep", daylightMinutes: "activity",
  vo2Max: "heart", bodyMass: "body", bodyFatPercent: "body", bloodPressure: "body", mindfulMinutes: "mood",
  heartAlerts: "alerts", watchAlerts: "alerts", ecg: "alerts", mood: "mood",
};

export function summaryJson(s: Summary, categories: Set<string>) {
  const show: Show = shows(categories);
  const pick = <T extends object>(object: T, fields: Record<string, Category>) =>
    Object.fromEntries(Object.entries(object).filter(([key]) => key === "day" || (fields[key] && show(fields[key]))));
  return {
    generatedAt: s.generatedAt,
    lastIngestAt: s.lastIngestAt,
    from: s.from,
    to: s.to,
    days: s.days,
    categories: [...categories],
    averages: pick(s.averages, DAY_FIELDS),
    previousAverages: pick(s.previousAverages, DAY_FIELDS),
    perDay: s.perDay.map((d) => pick(d, DAY_FIELDS)),
    health: pick(s.extras.health, HEALTH_FIELDS),
    measures: s.extras.measures.filter((m) => show(m.category)).map((m) => m.line.replace(/^\* /, "")),
    ...(show("workouts") ? { workouts: s.workouts, training: s.training } : {}),
    ...(show("nutrition") ? { lifestyle: s.extras.lifestyle, nutrients: s.extras.nutrients } : {}),
    ...(show("supplements") ? { medications: s.extras.medications } : {}),
    ...(show("symptoms") ? { symptoms: s.extras.symptoms } : {}),
    ...(show("history") && s.history ? { history: s.history } : {}),
    ...(show("calendar") ? { calendar: s.calendar } : {}),
    text: renderSummary(s, categories),
  };
}

function describeWorkout(w: WorkoutRow, hr: HrRow | null, extraRows: ExtraRow[], route: RouteRow | null): WorkoutData {
  let meta: WorkoutMeta = {};
  try {
    meta = JSON.parse(w.meta ?? "{}");
  } catch {
    // Unreadable meta: proceed with base fields.
  }
  const type = meta.activityType ?? 3000;
  const drift = hr?.first_half && hr.second_half
    ? Math.round((hr.second_half / hr.first_half - 1) * 100)
    : null;
  return {
    start: w.start_at,
    end: w.end_at,
    activity: ACTIVITY_NAMES[type] ?? `activity (code ${type})`,
    minutes: Math.round(w.value / 60),
    indoor: meta.indoor ?? null,
    energyKcal: meta.energyKcal ?? null,
    distanceKm: meta.distanceM ? meta.distanceM / 1000 : null,
    hrSamples: hr?.n ?? 0,
    avgHr: hr?.n ? hr.avg : null,
    maxHr: hr?.n ? hr.max : null,
    driftPercent: drift,
    ...workoutDetails(extraRows, w.start_at, w.end_at),
    sport: [...sportDetails(meta), ...routeDetails(route, meta), ...swimDetails(meta)],
    hasRoute: !!route,
  };
}

// From GPS route: km splits and, if Apple didn't already write it, elevation gain.
function routeDetails(route: RouteRow | null, meta: WorkoutMeta): string[] {
  if (!route) return [];
  const stats = routeStats(parsePoints(route.meta));
  if (!stats) return [];
  const parts: string[] = [];
  const splits = describeSplits(stats);
  if (splits) parts.push(splits);
  if (!meta.metadata?.HKElevationAscended && stats.climbM !== null) {
    parts.push(`elevation from GPS +${stats.climbM} m / -${stats.descentM} m`);
  }
  return parts;
}

// Swimming stroke styles (HKSwimmingStrokeStyle).
const STROKES = ["unrecognized style", "mixed", "freestyle", "backstroke", "breaststroke", "butterfly", "kickboard"];

// Pool swimming: pace per 100 m, SWOLF (strokes + seconds per lap) and styles.
function swimDetails(meta: WorkoutMeta): string[] {
  const laps = (meta.events ?? []).filter((e) => e.type === "lap" && e.d > 0);
  if (meta.activityType !== 46 || !laps.length) return [];
  const parts: string[] = [];
  const lapSeconds = laps.reduce((sum, e) => sum + e.d, 0) / laps.length;
  const length = Number.parseFloat(meta.metadata?.HKLapLength ?? "");
  const lengthM = meta.metadata?.HKLapLength?.endsWith(" yd") ? length * 0.9144 : length;
  if (lengthM > 0) parts.push(`pace ${pace(lapSeconds * 100 / lengthM)} /100 m in ${Math.round(lengthM)} m pool`);
  const strokes = meta.stats?.HKQuantityTypeIdentifierSwimmingStrokeCount?.sum;
  if (strokes) parts.push(`avg SWOLF ${Math.round(strokes / laps.length + lapSeconds)}`);
  const styles = new Map<string, number>();
  for (const e of laps) {
    const name = STROKES[e.style ?? 0] ?? STROKES[0];
    styles.set(name, (styles.get(name) ?? 0) + 1);
  }
  parts.push(`laps by style: ${[...styles.entries()].map(([name, count]) => `${name} ${count}`).join(", ")}`);
  return parts;
}

interface WorkoutMeta {
  activityType?: number;
  energyKcal?: number;
  distanceM?: number;
  indoor?: boolean;
  laps?: number;
  stats?: Record<string, { avg?: number; min?: number; max?: number; sum?: number }>;
  metadata?: Record<string, string>;
  // Laps and segments: start and duration in seconds, stroke style if present.
  events?: { type: "lap" | "segment"; t: number; d: number; style?: number }[];
}

// Running, swimming, cycling and diving details, from statistics Apple computes
// for each workout: only present when Watch recorded them.
function sportDetails(meta: WorkoutMeta): string[] {
  const stat = (name: string) => meta.stats?.[`HKQuantityTypeIdentifier${name}`];
  const parts: string[] = [];
  const speed = stat("RunningSpeed")?.avg;
  if (speed) {
    const secondsPerKm = 1000 / speed;
    parts.push(`avg pace ${Math.floor(secondsPerKm / 60)}:${String(Math.round(secondsPerKm % 60)).padStart(2, "0")} /km`);
  }
  const add = (name: string, label: string, unit: string, key: "avg" | "max" | "sum" = "avg", decimals = 0) => {
    const value = stat(name)?.[key];
    if (value) parts.push(`${label} ${value.toFixed(decimals)} ${unit}`);
  };
  add("RunningPower", "avg power", "W");
  add("RunningStrideLength", "stride", "m", "avg", 2);
  add("RunningVerticalOscillation", "vertical oscillation", "cm", "avg", 1);
  add("RunningGroundContactTime", "ground contact", "ms");
  add("CyclingPower", "avg power", "W");
  add("CyclingCadence", "cadence", "rpm");
  add("SwimmingStrokeCount", "strokes", "", "sum");
  add("UnderwaterDepth", "max depth", "m", "max", 1);
  add("WaterTemperature", "water", "°C", "avg", 1);
  if (meta.laps) parts.push(`${meta.laps} laps or lengths`);
  // Metadata arrives as HKQuantity text, e.g. "4520 cm" or "68 degF".
  const quantity = (text: string | undefined) => {
    const [value, unit] = (text ?? "").split(" ");
    return value && Number.isFinite(Number(value)) ? { value: Number(value), unit } : null;
  };
  const elevation = quantity(meta.metadata?.HKElevationAscended);
  if (elevation) parts.push(`elevation ${Math.round(elevation.unit === "cm" ? elevation.value / 100 : elevation.value)} m`);
  const weather = quantity(meta.metadata?.HKWeatherTemperature);
  if (weather) {
    const celsius = weather.unit === "degF" ? (weather.value - 32) * 5 / 9 : weather.value;
    parts.push(`outside temp ${Math.round(celsius)} °C`);
  }
  return parts;
}

// Today's steps, energy and exercise are partial: excluded from averages.
function averages(days: DayData[], today: string): Averages {
  const complete = days.filter((d) => d.day !== today);
  return {
    steps: mean(complete.map((d) => d.steps)),
    activeEnergyKcal: mean(complete.map((d) => d.activeEnergyKcal)),
    exerciseMinutes: mean(complete.map((d) => d.exerciseMinutes)),
    sleepMinutes: mean(days.map((d) => d.sleepMinutes)),
    deepMinutes: mean(days.map((d) => d.deepMinutes)),
    remMinutes: mean(days.map((d) => d.remMinutes)),
    restingHr: mean(days.map((d) => d.restingHr)),
    hrvMs: mean(days.map((d) => d.hrvMs)),
  };
}

// "6 h 5 min (deep 55 min, REM 1 h 23 min, core 3 h 47 min; awake 12 min in 4 awakenings; 23:41-06:20)".
// Apple doesn't distinguish N1 and N2: combines them into "core".
function sleepDetail(d: DayData): string {
  if (d.sleepMinutes === null) return "n/a";
  const stages = [
    d.deepMinutes !== null && `deep ${duration(d.deepMinutes)}`,
    d.remMinutes !== null && `REM ${duration(d.remMinutes)}`,
    d.coreMinutes !== null && `core ${duration(d.coreMinutes)}`,
  ].filter(Boolean).join(", ");
  const awake = d.awakeMinutes !== null ? `awake ${duration(d.awakeMinutes)} in ${d.awakenings} ${d.awakenings === 1 ? "awakening" : "awakenings"}` : "";
  const hours = d.bedtime && d.wakeTime ? `${formatTime(new Date(d.bedtime))}-${formatTime(new Date(d.wakeTime))}` : "";
  const detail = [stages, awake, hours].filter(Boolean).join("; ");
  return detail ? `${duration(d.sleepMinutes)} (${detail})` : duration(d.sleepMinutes);
}

function emptyDay(day: string): DayData {
  return {
    day,
    steps: null,
    activeEnergyKcal: null,
    exerciseMinutes: null,
    distanceKm: null,
    restingHr: null,
    hrvMs: null,
    sleepMinutes: null,
    deepMinutes: null,
    remMinutes: null,
    coreMinutes: null,
    awakeMinutes: null,
    awakenings: 0,
    bedtime: null,
    wakeTime: null,
    waterLiters: null,
  };
}

function push(map: Map<string, number[]>, key: string, value: number) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function mean(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length ? present.reduce((sum, v) => sum + v, 0) / present.length : null;
}

const integer = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0, useGrouping: "always" });
const oneDecimal = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 });

function num(value: number | null, unit = ""): string {
  if (value === null) return "n/a";
  return unit ? `${integer.format(value)} ${unit}` : integer.format(value);
}

function decimal(value: number): string {
  return oneDecimal.format(value);
}

function duration(minutes: number | null): string {
  if (minutes === null) return "n/a";
  const total = Math.round(minutes);
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (!hours) return `${rest} min`;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}
