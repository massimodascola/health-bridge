// Daily maintenance (cron at 03:30 UTC, or POST /maintenance):
// 1. calculates daily derived values (resting HR, HRV, sleep, ...) for the
//    last 100 days and saves them in the daily table, which is the permanent history;
// 2. deletes high-frequency samples older than 90 days.
// All calculation is done by SQLite: the free Worker has 10 ms of CPU.

import { addDays, dayRange, localDay, localMidnightUtc } from "./time";

const Q = "HKQuantityTypeIdentifier";
const SLEEP = "HKCategoryTypeIdentifierSleepAnalysis";
export const RETENTION_DAYS = 90;
const DERIVE_DAYS = 100;

// Daily average value, from samples that are kept forever anyway.
const AVERAGES: [type: string, metric: string, unit: string][] = [
  [`${Q}RestingHeartRate`, "restingHr", "bpm"],
  [`${Q}HeartRateVariabilitySDNN`, "hrv", "ms"],
  [`${Q}HeartRateVariabilityRMSSD`, "hrvRmssd", "ms"],
  [`${Q}RespiratoryRate`, "respiratoryRate", "count/min"],
  [`${Q}OxygenSaturation`, "oxygen", "%"],
  [`${Q}VO2Max`, "vo2Max", "ml/kg/min"],
  [`${Q}BodyMass`, "bodyMass", "kg"],
  [`${Q}BodyFatPercentage`, "bodyFat", "%"],
  [`${Q}WalkingHeartRateAverage`, "walkingHr", "bpm"],
];

// Sleep: the night takes the wake date (end + 6 hours), as in the summary.
const SLEEP_METRICS: [metric: string, values: string][] = [
  ["sleep", "1, 3, 4, 5"],
  ["sleepDeep", "4"],
  ["sleepRem", "5"],
];

// Frequent samples (one every few seconds or minutes): after 90 days only
// daily totals and statistics inside each workout remain.
const HIGH_FREQUENCY = [
  "HeartRate", "ActiveEnergyBurned", "BasalEnergyBurned", "DistanceWalkingRunning", "StepCount",
  "AppleExerciseTime", "AppleStandTime", "PhysicalEffort", "FlightsClimbed",
  "EnvironmentalAudioExposure", "HeadphoneAudioExposure",
  "WalkingSpeed", "WalkingStepLength", "WalkingAsymmetryPercentage", "WalkingDoubleSupportPercentage",
  "StairAscentSpeed", "StairDescentSpeed",
  "RunningPower", "RunningSpeed", "RunningStrideLength", "RunningVerticalOscillation", "RunningGroundContactTime",
  "DistanceCycling", "CyclingPower", "CyclingSpeed", "CyclingCadence",
  "DistanceSwimming", "SwimmingStrokeCount", "UnderwaterDepth",
  "RespiratoryRate", "OxygenSaturation", "TimeInDaylight",
].map((t) => `'${Q}${t}'`).join(", ");

export async function maintenance(db: D1Database, now: Date) {
  const yesterday = addDays(localDay(now), -1);
  // Dates are generated here, not from outside: they can be written into the query.
  const rows = dayRange(yesterday, DERIVE_DAYS)
    .map((day) => `('${day}', '${localMidnightUtc(day)}', '${localMidnightUtc(addDays(day, 1))}')`)
    .join(", ");
  const days = `WITH days(day, s, e) AS (VALUES ${rows})`;

  const statements = AVERAGES.map(([type, metric, unit]) => db.prepare(`${days}
    INSERT OR REPLACE INTO daily (day, metric, value, unit)
    SELECT d.day, '${metric}', avg(s.value), '${unit}' FROM days d
    JOIN samples s ON s.type = '${type}' AND s.start_at >= d.s AND s.start_at < d.e
    WHERE s.value IS NOT NULL GROUP BY d.day`));

  for (const [metric, values] of SLEEP_METRICS) {
    statements.push(db.prepare(`${days}
      INSERT OR REPLACE INTO daily (day, metric, value, unit)
      SELECT d.day, '${metric}', sum((julianday(s.end_at) - julianday(s.start_at)) * 1440), 'min' FROM days d
      JOIN samples s ON s.type = '${SLEEP}' AND s.value IN (${values})
        AND strftime('%Y-%m-%dT%H:%M:%SZ', s.end_at, '+6 hours') >= d.s
        AND strftime('%Y-%m-%dT%H:%M:%SZ', s.end_at, '+6 hours') < d.e
      GROUP BY d.day`));
  }

  const cutoff = `${addDays(localDay(now), -RETENTION_DAYS)}T00:00:00Z`;
  statements.push(db.prepare(`DELETE FROM samples WHERE type IN (${HIGH_FREQUENCY}) AND start_at < ?1`).bind(cutoff));

  const results = await db.batch(statements);
  return {
    derivedRows: results.slice(0, -1).reduce((sum, r) => sum + r.meta.changes, 0),
    prunedSamples: results[results.length - 1].meta.changes,
  };
}
