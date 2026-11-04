// Health, habits, supplements and workout details. These are rare or
// manually logged data: they appear in the summary only if present.

import { MEASURES, NUTRIENTS, SYMPTOM_TYPES, symptomLevel, symptomName } from "./catalog";
import type { Category, Show } from "./categories";
import { formatDay, localDay } from "./time";

const Q = "HKQuantityTypeIdentifier";
const C = "HKCategoryTypeIdentifier";

export const T = {
  daylight: `${Q}TimeInDaylight`,
  breathing: `${Q}AppleSleepingBreathingDisturbances`,
  respiratory: `${Q}RespiratoryRate`,
  oxygen: `${Q}OxygenSaturation`,
  vo2Max: `${Q}VO2Max`,
  bodyMass: `${Q}BodyMass`,
  bodyFat: `${Q}BodyFatPercentage`,
  systolic: `${Q}BloodPressureSystolic`,
  diastolic: `${Q}BloodPressureDiastolic`,
  water: `${Q}DietaryWater`,
  caffeine: `${Q}DietaryCaffeine`,
  alcohol: `${Q}NumberOfAlcoholicBeverages`,
  foodEnergy: `${Q}DietaryEnergyConsumed`,
  protein: `${Q}DietaryProtein`,
  carbs: `${Q}DietaryCarbohydrates`,
  fat: `${Q}DietaryFatTotal`,
  effort: `${Q}WorkoutEffortScore`,
  effortEstimated: `${Q}EstimatedWorkoutEffortScore`,
  hrRecovery: `${Q}HeartRateRecoveryOneMinute`,
  mindful: `${C}MindfulSession`,
  highHr: `${C}HighHeartRateEvent`,
  lowHr: `${C}LowHeartRateEvent`,
  irregular: `${C}IrregularHeartRhythmEvent`,
  hypertension: `${C}HypertensionEvent`,
  sleepApnea: `${C}SleepApneaEvent`,
  lowCardio: `${C}LowCardioFitnessEvent`,
  steadiness: `${C}AppleWalkingSteadinessEvent`,
  loudEnvironment: `${C}EnvironmentalAudioExposureEvent`,
  loudHeadphones: `${C}HeadphoneAudioExposureEvent`,
  handwashing: `${C}HandwashingEvent`,
  toothbrushing: `${C}ToothbrushingEvent`,
  ecg: "HKDataTypeIdentifierElectrocardiogram",
  // These two don't follow the same naming scheme as the others: verified with
  // HKObjectType on macOS 27 on 2026-10-05.
  mood: "HKDataTypeStateOfMind",
  medicationDose: "HKMedicationDoseEventTypeIdentifierMedicationDoseEvent",
} as const;

// Frequent samples (dozens per day): their averages are calculated by SQLite and arrive here
// already aggregated, along with those from catalog.ts.
export const AVERAGED_EXTRAS: string[] = [T.respiratory, T.oxygen, T.breathing];
export const DAILY_SUM_EXTRAS: string[] = [T.daylight];
const aggregated = new Set([...AVERAGED_EXTRAS, ...DAILY_SUM_EXTRAS]);

export const EXTRA_TYPES: string[] = [...Object.values(T).filter((t) => !aggregated.has(t)), ...SYMPTOM_TYPES];
const symptomTypes = new Set(SYMPTOM_TYPES);

// ECG classification (HKElectrocardiogramClassification).
const ECG_RESULTS: Record<number, string> = {
  1: "sinus rhythm",
  2: "atrial fibrillation",
  3: "inconclusive due to low heart rate",
  4: "inconclusive due to high heart rate",
  5: "inconclusive due to poor reading",
  6: "inconclusive",
  100: "unclassifiable",
};

// HKStateOfMind.Label labels, in value order (1 = surprised).
const MOOD_LABELS = [
  "", "surprised", "amused", "angry", "anxious", "ashamed", "brave", "calm",
  "content", "disappointed", "discouraged", "disgusted", "embarrassed", "enthusiastic", "frustrated",
  "grateful", "guilty", "happy", "hopeless", "irritated", "jealous", "joyful", "lonely",
  "passionate", "peaceful", "proud", "relieved", "sad", "scared", "stressed",
  "startled", "worried", "annoyed", "confident", "drained", "trusting",
  "indifferent", "overwhelmed", "satisfied",
];

const MINUTE = 60_000;

export interface ExtraRow {
  type: string;
  start_at: string;
  end_at: string;
  value: number | null;
  meta: string | null;
}

export interface Health {
  respiratoryRate: number | null;
  oxygenPercent: number | null;
  breathingDisturbances: number | null;
  daylightMinutes: number | null;
  vo2Max: { value: number; day: string } | null;
  bodyMass: { last: number; change: number | null } | null;
  bodyFatPercent: number | null;
  bloodPressure: { systolic: number; diastolic: number; readings: number } | null;
  mindfulMinutes: number;
  heartAlerts: { high: number; low: number; irregular: number };
  watchAlerts: { label: string; count: number }[];
  ecg: { count: number; results: string[] } | null;
  mood: { entries: number; averageValence: number; topLabels: string[] } | null;
}

export interface Lifestyle {
  waterLiters: number | null;
  // Water goal set in the app, today's total and days it was reached
  // (from the daily table). Added by buildSummary.
  water: { goalLiters: number | null; todayLiters: number | null; metDays: number; loggedDays: number } | null;
  caffeineMg: number | null;
  alcoholDrinks: number;
  food: { kcal: number | null; proteinG: number | null; carbsG: number | null; fatG: number | null; days: number } | null;
  handwashing: { count: number; avgSeconds: number } | null;
  toothbrushing: { count: number; avgSeconds: number; days: number } | null;
}

export interface Symptom {
  name: string;
  count: number;
  levels: string[];
  lastDay: string;
}

// Rows already aggregated by SQLite (see buildSummary in summary.ts).
export interface MeasureRow { type: string; n: number; avg: number | null; sum: number | null }
export interface LastRow { type: string; at: string; value: number | null }
export interface NutrientRow { type: string; total: number; days: number }

export interface MedicationAdherence {
  name: string;
  taken: number;
  skipped: number;
  missed: number;
  asNeeded: number;
}

// One row per dose (2026-10-25): used by morning briefing to know which supplements
// for today are already logged. status as in Health: taken, skipped, notInteracted...
export interface MedicationDose {
  name: string;
  status: string | null;
  scheduleType: string | null;
  scheduledAt: string | null;
  at: string;
}

export interface Extras {
  health: Health;
  lifestyle: Lifestyle;
  medications: MedicationAdherence[];
  doses: MedicationDose[];
  symptoms: Symptom[];
  measures: { category: Category; line: string }[];
  nutrients: string[];
}

export interface WorkoutDetails {
  effort: number | null;
  effortEstimated: boolean;
  hrRecoveryBpm: number | null;
}

export function computeExtras(
  rows: ExtraRow[],
  period: string[],
  today: string,
  aggregates: { measures: MeasureRow[]; last: LastRow[]; nutrients: NutrientRow[] },
): Extras {
  const days = new Set(period);
  const all = byType(rows);
  const inPeriod = byType(rows.filter((r) => days.has(localDay(new Date(r.start_at)))));
  const values = (type: string) => (inPeriod.get(type) ?? []).map((r) => r.value).filter(isNumber);

  // Sums per day, average over days with data. Today stays out if partial.
  const perDayMean = (type: string, skipToday: boolean) => {
    const sums = new Map<string, number>();
    for (const r of inPeriod.get(type) ?? []) {
      const day = localDay(new Date(r.start_at));
      if (skipToday && day === today) continue;
      sums.set(day, (sums.get(day) ?? 0) + (r.value ?? 0));
    }
    return { mean: mean([...sums.values()]), days: sums.size };
  };

  const averageOf = (type: string) => aggregates.measures.find((r) => r.type === type)?.avg ?? null;
  const daylight = aggregates.nutrients.find((r) => r.type === T.daylight);
  const vo2 = latest(all.get(T.vo2Max) ?? []);
  const weights = (inPeriod.get(T.bodyMass) ?? []).filter((r) => isNumber(r.value));
  const systolic = values(T.systolic);
  const diastolic = values(T.diastolic);

  const moods = inPeriod.get(T.mood) ?? [];
  const labelCounts = new Map<string, number>();
  for (const r of moods) {
    for (const label of parseMeta(r).labels ?? []) {
      const name = MOOD_LABELS[label];
      if (name) labelCounts.set(name, (labelCounts.get(name) ?? 0) + 1);
    }
  }

  const food = {
    kcal: perDayMean(T.foodEnergy, true),
    proteinG: perDayMean(T.protein, true),
    carbsG: perDayMean(T.carbs, true),
    fatG: perDayMean(T.fat, true),
  };
  const foodDays = Math.max(food.kcal.days, food.proteinG.days, food.carbsG.days, food.fatG.days);
  const water = perDayMean(T.water, true).mean;
  const seconds = (list: ExtraRow[]) =>
    mean(list.map((r) => (Date.parse(r.end_at) - Date.parse(r.start_at)) / 1000))!;
  const handwashing = inPeriod.get(T.handwashing) ?? [];
  const toothbrushing = inPeriod.get(T.toothbrushing) ?? [];
  const ecgs = inPeriod.get(T.ecg) ?? [];
  const ecgResults = new Map<string, number>();
  for (const r of ecgs) {
    const name = ECG_RESULTS[parseMeta(r).classification ?? 0] ?? "unclassified";
    ecgResults.set(name, (ecgResults.get(name) ?? 0) + 1);
  }
  const alerts: [type: string, label: string][] = [
    [T.hypertension, "possible hypertension"],
    [T.sleepApnea, "possible sleep apnea"],
    [T.lowCardio, "low cardio fitness"],
    [T.steadiness, "low walking steadiness"],
    [T.loudEnvironment, "loud environment"],
    [T.loudHeadphones, "loud headphones"],
  ];

  return {
    health: {
      respiratoryRate: averageOf(T.respiratory),
      oxygenPercent: averageOf(T.oxygen),
      breathingDisturbances: averageOf(T.breathing),
      daylightMinutes: daylight?.days ? daylight.total / daylight.days : null,
      vo2Max: vo2 && isNumber(vo2.value) ? { value: vo2.value, day: localDay(new Date(vo2.start_at)) } : null,
      bodyMass: weights.length
        ? {
            last: weights[weights.length - 1].value!,
            change: weights.length > 1 ? weights[weights.length - 1].value! - weights[0].value! : null,
          }
        : null,
      bodyFatPercent: latest(inPeriod.get(T.bodyFat) ?? [])?.value ?? null,
      bloodPressure: systolic.length && diastolic.length
        ? { systolic: mean(systolic)!, diastolic: mean(diastolic)!, readings: systolic.length }
        : null,
      mindfulMinutes: (inPeriod.get(T.mindful) ?? [])
        .reduce((sum, r) => sum + (Date.parse(r.end_at) - Date.parse(r.start_at)) / MINUTE, 0),
      heartAlerts: {
        high: inPeriod.get(T.highHr)?.length ?? 0,
        low: inPeriod.get(T.lowHr)?.length ?? 0,
        irregular: inPeriod.get(T.irregular)?.length ?? 0,
      },
      watchAlerts: alerts
        .map(([type, label]) => ({ label, count: inPeriod.get(type)?.length ?? 0 }))
        .filter((a) => a.count > 0),
      ecg: ecgs.length
        ? { count: ecgs.length, results: [...ecgResults.entries()].map(([name, count]) => `${name} ${count}`) }
        : null,
      mood: moods.length
        ? {
            entries: moods.length,
            averageValence: mean(moods.map((r) => r.value).filter(isNumber))!,
            topLabels: [...labelCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name]) => name),
          }
        : null,
    },
    lifestyle: {
      waterLiters: water === null ? null : water / 1000,
      water: null,
      caffeineMg: perDayMean(T.caffeine, true).mean,
      alcoholDrinks: values(T.alcohol).reduce((sum, v) => sum + v, 0),
      food: foodDays
        ? { kcal: food.kcal.mean, proteinG: food.proteinG.mean, carbsG: food.carbsG.mean, fatG: food.fatG.mean, days: foodDays }
        : null,
      handwashing: handwashing.length ? { count: handwashing.length, avgSeconds: seconds(handwashing) } : null,
      toothbrushing: toothbrushing.length
        ? {
            count: toothbrushing.length,
            avgSeconds: seconds(toothbrushing),
            days: new Set(toothbrushing.map((r) => localDay(new Date(r.start_at)))).size,
          }
        : null,
    },
    medications: adherence(inPeriod.get(T.medicationDose) ?? []),
    doses: (inPeriod.get(T.medicationDose) ?? []).map((r) => {
      const meta = parseMeta(r);
      return {
        name: meta.medication?.trim() || "unnamed medication",
        status: meta.status ?? null,
        scheduleType: meta.scheduleType ?? null,
        scheduledAt: meta.scheduledAt ?? null,
        at: r.start_at,
      };
    }),
    symptoms: symptoms(rows.filter((r) => symptomTypes.has(r.type) && days.has(localDay(new Date(r.start_at))))),
    measures: measures(aggregates.measures, aggregates.last),
    nutrients: nutrients(aggregates.nutrients),
  };
}

function symptoms(rows: ExtraRow[]): Symptom[] {
  const byName = new Map<string, Symptom>();
  for (const r of rows) {
    const level = symptomLevel(r.type, r.value);
    if (!level) continue;
    const name = symptomName(r.type);
    const day = localDay(new Date(r.start_at));
    const entry = byName.get(name) ?? { name, count: 0, levels: [], lastDay: day };
    entry.count++;
    entry.levels.push(level);
    if (day > entry.lastDay) entry.lastDay = day;
    byName.set(name, entry);
  }
  return [...byName.values()].sort((a, b) => b.count - a.count);
}

// "* HRV (RMSSD): 48 ms (average of 12 measurements)", "* FTP on bike: 250 W (last value, Oct 3)".
function measures(periodRows: MeasureRow[], lastRows: LastRow[]): Extras["measures"] {
  const lines: Extras["measures"] = [];
  for (const m of MEASURES) {
    const unit = !m.unit ? "" : m.unit === "%" ? "%" : ` ${m.unit}`;
    if (m.show === "last") {
      const row = lastRows.find((r) => r.type === m.type);
      if (row && isNumber(row.value)) {
        lines.push({ category: m.category, line: `* ${m.label}: ${fmt(row.value * m.factor, m.decimals)}${unit} (last value, ${formatDay(localDay(new Date(row.at)))})` });
      }
      continue;
    }
    const row = periodRows.find((r) => r.type === m.type);
    if (!row?.n) continue;
    if (m.show === "sum" && isNumber(row.sum)) {
      lines.push({ category: m.category, line: `* ${m.label}: ${fmt(row.sum * m.factor, m.decimals)}${unit} in the period` });
    } else if (isNumber(row.avg)) {
      lines.push({ category: m.category, line: `* ${m.label}: ${fmt(row.avg * m.factor, m.decimals)}${unit} (average of ${plural(row.n, "measurement", "measurements")})` });
    }
  }
  return lines;
}

function nutrients(rows: NutrientRow[]): string[] {
  return NUTRIENTS.flatMap((nutrient) => {
    const row = rows.find((r) => r.type === nutrient.type);
    if (!row?.days) return [];
    const value = row.total / row.days;
    return [`${nutrient.label} ${fmt(value, value < 10 ? 1 : 0)} ${nutrient.unit}`];
  });
}

// Declared effort (or estimated by Watch) and heart rate recovery of a workout.
export function workoutDetails(rows: ExtraRow[], start: string, end: string): WorkoutDetails {
  const from = Date.parse(start) - MINUTE;
  const to = Date.parse(end) + MINUTE;
  const during = (type: string) =>
    rows.find((r) => r.type === type && isNumber(r.value) && Date.parse(r.start_at) >= from && Date.parse(r.start_at) <= to);
  const rated = during(T.effort);
  const estimated = during(T.effortEstimated);
  const recovery = rows.find((r) =>
    r.type === T.hrRecovery && isNumber(r.value)
    && Date.parse(r.start_at) >= Date.parse(end) - 5 * MINUTE
    && Date.parse(r.start_at) <= Date.parse(end) + 30 * MINUTE);
  return {
    effort: rated?.value ?? estimated?.value ?? null,
    effortEstimated: !rated && !!estimated,
    hrRecoveryBpm: recovery?.value ?? null,
  };
}

// Each row belongs to a category: automations show only their own.
export function renderExtras(e: Extras, show: Show = () => true): string[] {
  const h = e.health;
  const health: string[] = [];
  const add = (category: Category, line: string) => {
    if (show(category)) health.push(line);
  };
  if (h.respiratoryRate !== null) add("heart", `* Respiratory rate: ${fmt(h.respiratoryRate, 1)} breaths per minute`);
  if (h.oxygenPercent !== null) add("heart", `* Blood oxygen: ${fmt(h.oxygenPercent)}%`);
  if (h.breathingDisturbances !== null) add("sleep", `* Sleep respiratory disturbances (Apple index): ${fmt(h.breathingDisturbances, 1)} on average`);
  if (h.daylightMinutes !== null) add("activity", `* Daylight: ${fmt(h.daylightMinutes)} min per day`);
  if (h.vo2Max) add("heart", `* VO2 max: ${fmt(h.vo2Max.value, 1)} ml/kg/min (last estimate, ${formatDay(h.vo2Max.day)})`);
  if (h.bodyMass) {
    const change = h.bodyMass.change === null ? "" : `, change in period ${signed(h.bodyMass.change, 1)} kg`;
    const fat = h.bodyFatPercent === null ? "" : `, body fat ${fmt(h.bodyFatPercent, 1)}%`;
    add("body", `* Weight: ${fmt(h.bodyMass.last, 1)} kg${change}${fat}`);
  }
  if (h.bloodPressure) {
    add("body", `* Blood pressure: ${fmt(h.bloodPressure.systolic)}/${fmt(h.bloodPressure.diastolic)} mmHg on average (${plural(h.bloodPressure.readings, "measurement", "measurements")})`);
  }
  if (h.mindfulMinutes > 0) add("mood", `* Mindfulness: ${fmt(h.mindfulMinutes)} min total`);
  const alerts = [
    h.heartAlerts.high && `${h.heartAlerts.high} high heart rate`,
    h.heartAlerts.low && `${h.heartAlerts.low} low heart rate`,
    h.heartAlerts.irregular && `${h.heartAlerts.irregular} irregular rhythm`,
  ].filter(Boolean);
  if (alerts.length) add("alerts", `* Watch heart alerts: ${alerts.join(", ")}`);
  if (h.watchAlerts.length) {
    add("alerts", `* Other Watch alerts: ${h.watchAlerts.map((a) => `${a.label} ${a.count}`).join(", ")}`);
  }
  if (h.ecg) add("alerts", `* ECG: ${plural(h.ecg.count, "recording", "recordings")} (${h.ecg.results.join(", ")})`);
  if (h.mood) {
    const labels = h.mood.topLabels.length ? `, most frequent: ${h.mood.topLabels.join(", ")}` : "";
    add("mood", `* Mood: ${plural(h.mood.entries, "recording", "recordings")}, average ${signed(h.mood.averageValence, 1)} (from -1 very unpleasant to +1 very pleasant)${labels}`);
  }

  const l = e.lifestyle;
  const habits: string[] = [];
  const w = l.water;
  if (l.waterLiters !== null || w?.goalLiters) {
    const parts = [l.waterLiters !== null ? `${fmt(l.waterLiters, 1)} liters per day` : "no glasses logged in the period"];
    if (w?.goalLiters) parts.push(`goal ${fmt(w.goalLiters, 1)} liters, reached in ${w.metDays} days out of ${w.loggedDays} logged`);
    if (w?.todayLiters !== null && w?.todayLiters !== undefined) parts.push(`today so far ${fmt(w.todayLiters, 1)} liters`);
    habits.push(`* Water: ${parts.join("; ")}`);
  }
  if (l.caffeineMg !== null) habits.push(`* Caffeine: ${fmt(l.caffeineMg)} mg per day`);
  if (l.alcoholDrinks > 0) habits.push(`* Alcohol: ${plural(l.alcoholDrinks, "drink", "drinks")} in the period`);
  if (l.food) {
    const parts = [
      l.food.kcal !== null && `${fmt(l.food.kcal)} kcal`,
      l.food.proteinG !== null && `protein ${fmt(l.food.proteinG)} g`,
      l.food.carbsG !== null && `carbs ${fmt(l.food.carbsG)} g`,
      l.food.fatG !== null && `fat ${fmt(l.food.fatG)} g`,
    ].filter(Boolean);
    habits.push(`* Nutrition, average of ${l.food.days} logged days: ${parts.join(", ")}`);
  }
  if (e.nutrients.length) habits.push(`* Micronutrients from logged food, average of days with data: ${e.nutrients.join(", ")}`);
  if (l.handwashing) habits.push(`* Handwashing: ${plural(l.handwashing.count, "time", "times")}, ${fmt(l.handwashing.avgSeconds)} seconds on average`);
  if (l.toothbrushing) {
    habits.push(`* Teeth: brushed ${plural(l.toothbrushing.count, "time", "times")} in ${plural(l.toothbrushing.days, "day", "days")}, ${fmt(l.toothbrushing.avgSeconds)} seconds on average`);
  }

  const meds = e.medications.map((m) => {
    const parts = [`taken ${m.taken}`, `skipped ${m.skipped}`, `not logged ${m.missed}`];
    if (m.asNeeded) parts.push(`as needed ${m.asNeeded}`);
    return `* ${m.name}: ${parts.join(", ")}`;
  });

  const symptoms = e.symptoms.map((s) => {
    const levels = new Map<string, number>();
    for (const level of s.levels) levels.set(level, (levels.get(level) ?? 0) + 1);
    const detail = [...levels.entries()].map(([level, count]) => `${level} ${count}`).join(", ");
    return `* ${s.name}: ${plural(s.count, "time", "times")} (${detail}), last on ${formatDay(s.lastDay)}`;
  });

  const measures = e.measures.filter((m) => show(m.category)).map((m) => m.line);

  const lines: string[] = [];
  if (health.length) lines.push("", "Health and recovery, in the period:", ...health);
  if (symptoms.length && show("symptoms")) lines.push("", "Symptoms logged in the period:", ...symptoms);
  if (measures.length) lines.push("", "Other measured values:", ...measures);
  if (habits.length && show("nutrition")) lines.push("", "Habits and nutrition (only logged days, today excluded):", ...habits);
  if (meds.length && show("supplements")) lines.push("", "Supplements and medications, doses in the period:", ...meds);
  return lines;
}

function adherence(rows: ExtraRow[]): MedicationAdherence[] {
  const byName = new Map<string, MedicationAdherence>();
  for (const r of rows) {
    const meta = parseMeta(r);
    const name = meta.medication?.trim() || "unnamed medication";
    const entry = byName.get(name) ?? { name, taken: 0, skipped: 0, missed: 0, asNeeded: 0 };
    if (meta.status === "taken" && meta.scheduleType === "asNeeded") entry.asNeeded++;
    else if (meta.status === "taken") entry.taken++;
    else if (meta.status === "skipped") entry.skipped++;
    else if (meta.status === "notInteracted" || meta.status === "notificationNotSent") entry.missed++;
    byName.set(name, entry);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, "en"));
}

interface Meta {
  labels?: number[];
  classification?: number;
  medication?: string;
  status?: string;
  scheduleType?: string;
  scheduledAt?: string;
}

function parseMeta(row: ExtraRow): Meta {
  try {
    return JSON.parse(row.meta ?? "{}") as Meta;
  } catch {
    return {};
  }
}

function byType(rows: ExtraRow[]): Map<string, ExtraRow[]> {
  const map = new Map<string, ExtraRow[]>();
  for (const r of rows) {
    const list = map.get(r.type);
    if (list) list.push(r);
    else map.set(r.type, [r]);
  }
  return map;
}

function latest(rows: ExtraRow[]): ExtraRow | null {
  return rows.reduce<ExtraRow | null>((best, r) => (!best || r.start_at > best.start_at ? r : best), null);
}

function isNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
}

const formatters = new Map<number, Intl.NumberFormat>();
function fmt(value: number, decimals = 0): string {
  let f = formatters.get(decimals);
  if (!f) {
    f = new Intl.NumberFormat("en-GB", { maximumFractionDigits: decimals, useGrouping: "always" });
    formatters.set(decimals, f);
  }
  return f.format(value);
}

function plural(count: number, one: string, many: string): string {
  return `${fmt(count)} ${count === 1 ? one : many}`;
}

function signed(value: number, decimals = 0): string {
  return `${value > 0 ? "+" : ""}${fmt(value, decimals)}`;
}
