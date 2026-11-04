// History for the coach, from the daily table (permanent) and workouts, which
// are never deleted: profile, reference values, monthly trend,
// workouts per year and best periods.

import { ACTIVITY_NAMES } from "./activities";
import { SYMPTOM_TYPES, symptomLevel, symptomName } from "./catalog";
import type { Category, Show } from "./categories";
import { TIME_ZONE, addDays } from "./time";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface History {
  firstDay: string | null;
  profile: { age: number | null; sex: string | null; heightM: number | null };
  weight: { value: number; month: string } | null;
  baselines: { category: Category; label: string; unit: string; time: boolean; last90: Range | null; last365: Range | null }[];
  vo2Max: { latest: { value: number; month: string } | null; best: { value: number; month: string } | null };
  months: MonthRow[];
  years: { year: string; count: number; hours: number; top: string[] }[];
  best: { lowestRestingHr: MonthRow[]; highestHrv: MonthRow[] };
  lastByActivity: { activity: string; last: string; count: number }[];
  diary: DiaryRow[];
  recentDays: { day: string; sleep: number | null; restingHr: number | null; hrv: number | null; steps: number | null; exercise: number | null }[];
  symptoms: { name: string; count: number; last: string }[];
}

interface DiaryRow {
  start: string;
  activity: string;
  minutes: number;
  km: number | null;
  kcal: number | null;
  hrAvg: number | null;
  hrMax: number | null;
  paceSecondsPerKm: number | null;
}

// Activities with pace per km: running, walking, hiking.
const PACED = new Set([37, 52, 24]);

interface Range { low: number; median: number; high: number }
interface MonthRow { month: string; restingHr: number | null; hrv: number | null; sleep: number | null; steps: number | null; workouts: number; hours: number }

const BASELINES: [metric: string, label: string, unit: string, time: boolean, category: Category][] = [
  ["restingHr", "Resting HR", "bpm", false, "heart"],
  ["hrv", "HRV (SDNN)", "ms", false, "heart"],
  ["sleep", "Sleep", "", true, "sleep"],
  ["steps", "Steps", "", false, "activity"],
  ["activeEnergy", "Active energy", "kcal", false, "activity"],
  ["exerciseTime", "Exercise", "min", false, "activity"],
];

export async function buildHistory(db: D1Database, today: string): Promise<History> {
  const yearAgo = addDays(today, -365);
  const ninetyAgo = addDays(today, -90);
  const [recentRes, monthlyRes, workoutsRes, profileRes, firstRes, diaryRes, lastRes, symptomsRes] = await db.batch([
    // One row per day instead of one row per metric: a third of the data to read.
    db.prepare(`SELECT day, ${BASELINES.map(([metric]) => `max(CASE WHEN metric = '${metric}' THEN value END) AS ${metric}`).join(", ")}
      FROM daily WHERE day > ?1 AND day < ?2 GROUP BY day`).bind(yearAgo, today),
    db.prepare(`SELECT substr(day, 1, 7) AS month, metric, avg(value) AS value, count(*) AS days FROM daily
      WHERE metric IN ('restingHr', 'hrv', 'sleep', 'steps', 'vo2Max', 'bodyMass') AND day < ?1
      GROUP BY month, metric`).bind(today),
    // "activity", not "type": with "type" SQLite would group by the homonymous column.
    db.prepare(`SELECT substr(start_at, 1, 7) AS month, json_extract(meta, '$.activityType') AS activity,
      count(*) AS count, sum(value) / 3600.0 AS hours FROM samples
      WHERE type = 'HKWorkoutTypeIdentifier' GROUP BY month, activity`),
    db.prepare("SELECT key, value FROM profile"),
    db.prepare("SELECT min(day) AS first FROM daily"),
    // Only diary fields: full meta weighs 1-2 KB per workout.
    db.prepare(`SELECT start_at, value, json_extract(meta, '$.activityType') AS activity,
        json_extract(meta, '$.distanceM') AS meters, json_extract(meta, '$.energyKcal') AS kcal,
        json_extract(meta, '$.stats.HKQuantityTypeIdentifierHeartRate.avg') AS hr_avg,
        json_extract(meta, '$.stats.HKQuantityTypeIdentifierHeartRate.max') AS hr_max
      FROM samples WHERE type = 'HKWorkoutTypeIdentifier' AND start_at >= ?1 ORDER BY start_at DESC`).bind(`${yearAgo}T00:00:00Z`),
    db.prepare(`SELECT json_extract(meta, '$.activityType') AS activity, max(start_at) AS last, count(*) AS count
      FROM samples WHERE type = 'HKWorkoutTypeIdentifier' GROUP BY activity ORDER BY last DESC`),
    db.prepare(`SELECT type, value, start_at FROM samples WHERE start_at >= ?1
      AND type IN (${SYMPTOM_TYPES.map((_, i) => `?${i + 2}`).join(", ")})`).bind(`${yearAgo}T00:00:00Z`, ...SYMPTOM_TYPES),
  ]);

  const recent = recentRes.results as unknown as ({ day: string } & Record<string, number | null>)[];
  const baselines = BASELINES.map(([metric, label, unit, time, category]) => {
    const all = recent.filter((r) => (r[metric] ?? 0) > 0);
    return {
      category, label, unit, time,
      last90: range(all.filter((r) => r.day > ninetyAgo).map((r) => r[metric]!)),
      last365: range(all.map((r) => r[metric]!)),
    };
  });

  const monthly = monthlyRes.results as unknown as { month: string; metric: string; value: number; days: number }[];
  const workouts = workoutsRes.results as unknown as { month: string; activity: number | null; count: number; hours: number }[];
  const byMonth = new Map<string, MonthRow>();
  const row = (month: string) => {
    let r = byMonth.get(month);
    if (!r) {
      r = { month, restingHr: null, hrv: null, sleep: null, steps: null, workouts: 0, hours: 0 };
      byMonth.set(month, r);
    }
    return r;
  };
  for (const m of monthly) {
    if (m.metric === "restingHr") row(m.month).restingHr = m.value;
    if (m.metric === "hrv") row(m.month).hrv = m.value;
    if (m.metric === "sleep") row(m.month).sleep = m.value;
    if (m.metric === "steps") row(m.month).steps = m.value;
  }
  const years = new Map<string, { count: number; hours: number; types: Map<string, number> }>();
  for (const w of workouts) {
    const r = row(w.month);
    r.workouts += w.count;
    r.hours += w.hours ?? 0;
    const year = w.month.slice(0, 4);
    const y = years.get(year) ?? { count: 0, hours: 0, types: new Map() };
    y.count += w.count;
    y.hours += w.hours ?? 0;
    const name = activityName(w.activity);
    y.types.set(name, (y.types.get(name) ?? 0) + w.count);
    years.set(year, y);
  }

  const vo2 = monthly.filter((m) => m.metric === "vo2Max").sort((a, b) => a.month.localeCompare(b.month));
  const weights = monthly.filter((m) => m.metric === "bodyMass").sort((a, b) => a.month.localeCompare(b.month));
  const bestVo2 = vo2.reduce<typeof vo2[number] | null>((best, m) => (!best || m.value > best.value ? m : best), null);
  const solid = (m: { month: string; metric: string; days: number }) => m.days >= 10;
  const months = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));

  // Days from 15th to 90th ago in compact form: the last 14 are already in detail above.
  const fourteenAgo = addDays(today, -13);
  const dayMap = new Map<string, History["recentDays"][number]>();
  for (const r of recent) {
    if (r.day <= ninetyAgo || r.day >= fourteenAgo) continue;
    dayMap.set(r.day, {
      day: r.day, sleep: r.sleep ?? null, restingHr: r.restingHr ?? null, hrv: r.hrv ?? null,
      steps: r.steps ?? null, exercise: r.exerciseTime ?? null,
    });
  }

  type DiaryQueryRow = { start_at: string; value: number; activity: number | null; meters: number | null;
    kcal: number | null; hr_avg: number | null; hr_max: number | null };
  const diary = (diaryRes.results as unknown as DiaryQueryRow[]).map((w) => {
    const type = w.activity ?? 3000;
    const km = w.meters ? w.meters / 1000 : null;
    return {
      start: w.start_at,
      activity: activityName(type),
      minutes: Math.round(w.value / 60),
      km,
      kcal: w.kcal,
      hrAvg: w.hr_avg,
      hrMax: w.hr_max,
      paceSecondsPerKm: PACED.has(type) && km && km > 0.3 ? w.value / km : null,
    };
  });

  const symptoms = new Map<string, { name: string; count: number; last: string }>();
  for (const r of symptomsRes.results as unknown as { type: string; value: number | null; start_at: string }[]) {
    if (!symptomLevel(r.type, r.value)) continue;
    const name = symptomName(r.type);
    const entry = symptoms.get(name) ?? { name, count: 0, last: r.start_at };
    entry.count++;
    if (r.start_at > entry.last) entry.last = r.start_at;
    symptoms.set(name, entry);
  }

  const profile = new Map((profileRes.results as unknown as { key: string; value: string }[]).map((p) => [p.key, p.value]));
  const birth = profile.get("dateOfBirth");

  return {
    firstDay: (firstRes.results[0] as { first: string | null } | undefined)?.first ?? null,
    profile: {
      age: birth ? age(birth, today) : null,
      sex: profile.get("sex") ?? null,
      heightM: profile.has("heightM") ? Number(profile.get("heightM")) : null,
    },
    weight: weights.length ? { value: weights[weights.length - 1].value, month: weights[weights.length - 1].month } : null,
    baselines,
    vo2Max: {
      latest: vo2.length ? { value: vo2[vo2.length - 1].value, month: vo2[vo2.length - 1].month } : null,
      best: bestVo2 ? { value: bestVo2.value, month: bestVo2.month } : null,
    },
    months: months.filter((m) => m.month < today.slice(0, 7) && (m.restingHr !== null || m.workouts > 0)),
    years: [...years.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([year, y]) => ({
      year, count: y.count, hours: y.hours,
      top: [...y.types.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} ${count}`),
    })),
    best: {
      lowestRestingHr: bestMonths(monthly, "restingHr", solid, byMonth, (a, b) => a - b),
      highestHrv: bestMonths(monthly, "hrv", solid, byMonth, (a, b) => b - a),
    },
    lastByActivity: (lastRes.results as unknown as { activity: number | null; last: string; count: number }[])
      .map((r) => ({ activity: activityName(r.activity), last: r.last, count: r.count })),
    diary,
    recentDays: [...dayMap.values()].sort((a, b) => b.day.localeCompare(a.day)),
    symptoms: [...symptoms.values()].sort((a, b) => b.last.localeCompare(a.last)),
  };
}

// History sections follow categories: workout diary only with
// "workouts", symptoms only with "symptoms", and so on.
export function renderHistory(h: History, show: Show = () => true): string[] {
  const lines = ["", `History${h.firstDay ? ` (data from ${formatMonth(h.firstDay.slice(0, 7))})` : ""}:`];
  const p = h.profile;
  const profile = [
    p.age !== null && `${p.age} years old`,
    p.sex === "male" ? "male" : p.sex === "female" ? "female" : null,
    p.heightM !== null && `${p.heightM.toFixed(2)} m`,
    h.weight && `${fmt(h.weight.value, 1)} kg (${formatMonth(h.weight.month)})`,
  ].filter(Boolean);
  if (profile.length) lines.push(`* Profile: ${profile.join(", ")}`);

  const baselines = h.baselines.filter((b) => b.last365 && show(b.category)).map((b) => {
    const range = (r: Range | null) => (r ? `${val(r.median, b)} (${val(r.low, b, false)}–${val(r.high, b)})` : "n/a");
    return `* ${b.label}: last 90 days ${range(b.last90)}, last year ${range(b.last365)}`;
  });
  if (h.vo2Max.latest && show("heart")) {
    const best = h.vo2Max.best ? `, best ${fmt(h.vo2Max.best.value, 1)} (${formatMonth(h.vo2Max.best.month)})` : "";
    baselines.push(`* VO2 max: latest ${fmt(h.vo2Max.latest.value, 1)} (${formatMonth(h.vo2Max.latest.month)})${best}`);
  }
  if (baselines.length) {
    lines.push("", "Reference values: median and normal range (10th to 90th percentile of days):", ...baselines);
  }

  const workouts = show("workouts");
  if (h.lastByActivity.length && workouts) {
    lines.push("", "Last time for each activity (all-time):");
    for (const a of h.lastByActivity) lines.push(`* ${a.activity}: ${formatDate(a.last)} (${a.count} total)`);
  }
  if (h.symptoms.length && show("symptoms")) {
    lines.push("", "Symptoms logged in the last 12 months:");
    for (const s of h.symptoms) lines.push(`* ${s.name}: ${s.count} ${s.count === 1 ? "time" : "times"}, last ${formatDate(s.last)}`);
  }
  if (h.diary.length && workouts) {
    lines.push("", `Workout diary, last 12 months (${h.diary.length}, most recent first):`);
    for (const w of h.diary) {
      const parts = [w.activity, `${w.minutes} min`];
      if (w.km) parts.push(`${fmt(w.km, 1)} km`);
      if (w.paceSecondsPerKm) parts.push(`pace ${Math.floor(w.paceSecondsPerKm / 60)}:${String(Math.round(w.paceSecondsPerKm % 60)).padStart(2, "0")} /km`);
      if (w.kcal) parts.push(`${fmt(w.kcal)} kcal`);
      if (w.hrAvg) parts.push(`avg HR ${fmt(w.hrAvg)}${w.hrMax ? ` (max ${fmt(w.hrMax)})` : ""}`);
      lines.push(`* ${formatDate(w.start, true)}: ${parts.join(", ")}`);
    }
  }
  type Day = History["recentDays"][number];
  const dayColumns = ([
    ["sleep", "sleep", (d: Day) => duration(d.sleep)],
    ["heart", "resting HR", (d: Day) => `${fmt(d.restingHr)} bpm`],
    ["heart", "HRV", (d: Day) => `${fmt(d.hrv)} ms`],
    ["activity", "steps", (d: Day) => `${fmt(d.steps)} steps`],
    ["activity", "exercise", (d: Day) => `${fmt(d.exercise)} min`],
  ] as [Category, string, (d: Day) => string][]).filter(([category]) => show(category));
  if (h.recentDays.length && dayColumns.length) {
    lines.push("", `Days 15 to 90 days ago (${dayColumns.map(([, label]) => label).join(", ")}):`);
    for (const d of h.recentDays) {
      lines.push(`* ${formatDate(`${d.day}T12:00:00Z`)}: ${dayColumns.map(([, , value]) => value(d)).join(", ")}`);
    }
  }

  const monthColumns = ([
    ["heart", (m: MonthRow) => `resting HR ${fmt(m.restingHr)}`],
    ["heart", (m: MonthRow) => `HRV ${fmt(m.hrv)}`],
    ["sleep", (m: MonthRow) => `sleep ${duration(m.sleep)}`],
    ["activity", (m: MonthRow) => `steps ${fmt(m.steps)}`],
    ["workouts", (m: MonthRow) => `workouts ${m.workouts} (${fmt(m.hours)} h)`],
  ] as [Category, (m: MonthRow) => string][]).filter(([category]) => show(category));
  if (h.months.length && monthColumns.length) {
    lines.push("", "Monthly trend all-time (averages):");
    for (const m of h.months) {
      lines.push(`* ${formatMonth(m.month)}: ${monthColumns.map(([, value]) => value(m)).join(", ")}`);
    }
  }
  if (h.years.length && workouts) {
    lines.push("", "Workouts per year:");
    for (const y of h.years) lines.push(`* ${y.year}: ${y.count} (${fmt(y.hours)} h), ${y.top.join(", ")}`);
  }
  const best = (rows: MonthRow[], what: (r: MonthRow) => string) =>
    rows.map((r) => `${formatMonth(r.month)} ${what(r)} with ${r.workouts} workouts (${fmt(r.hours)} h)`).join("; ");
  if ((h.best.lowestRestingHr.length || h.best.highestHrv.length) && show("heart")) {
    lines.push("", "Best periods:");
    if (h.best.lowestRestingHr.length) lines.push(`* Lowest resting HR: ${best(h.best.lowestRestingHr, (r) => `${fmt(r.restingHr)} bpm`)}`);
    if (h.best.highestHrv.length) lines.push(`* Highest HRV: ${best(h.best.highestHrv, (r) => `${fmt(r.hrv)} ms`)}`);
  }
  return lines;
}

function bestMonths(
  monthly: { month: string; metric: string; value: number; days: number }[],
  metric: string,
  solid: (m: { month: string; metric: string; days: number }) => boolean,
  byMonth: Map<string, MonthRow>,
  order: (a: number, b: number) => number,
): MonthRow[] {
  return monthly.filter((m) => m.metric === metric && solid(m))
    .sort((a, b) => order(a.value, b.value)).slice(0, 3)
    .map((m) => byMonth.get(m.month)!);
}

export function activityName(type: number | null): string {
  if (type === null) return "other";
  return ACTIVITY_NAMES[type] ?? `activity ${type}`;
}

function range(values: number[]): Range | null {
  if (values.length < 5) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
  return { low: at(0.1), median: at(0.5), high: at(0.9) };
}

function age(birth: string, today: string): number {
  const [by, bm, bd] = birth.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

const dateLabel = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE, weekday: "short", day: "numeric", month: "short", year: "numeric",
});
const dateTimeLabel = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
});

function formatDate(iso: string, withTime = false): string {
  return (withTime ? dateTimeLabel : dateLabel).format(new Date(iso));
}

function formatMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

const formatters = new Map<number, Intl.NumberFormat>();
function fmt(value: number | null, decimals = 0): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  let f = formatters.get(decimals);
  if (!f) {
    f = new Intl.NumberFormat("en-GB", { maximumFractionDigits: decimals, useGrouping: "always" });
    formatters.set(decimals, f);
  }
  return f.format(value);
}

function duration(minutes: number | null): string {
  if (minutes === null) return "n/a";
  const total = Math.round(minutes);
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (!hours) return `${rest} min`;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function val(value: number, b: { unit: string; time: boolean }, withUnit = true): string {
  if (b.time) return duration(value);
  return `${fmt(value)}${withUnit && b.unit ? ` ${b.unit}` : ""}`;
}
