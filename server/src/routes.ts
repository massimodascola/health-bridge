// GPS routes for outdoor workouts. The app sends a point roughly every 5 seconds:
// [seconds from start, latitude, longitude, altitude in meters].
// From here come the km splits, elevation gain/loss, and the GPX file.

export const ROUTE = "HKWorkoutRouteTypeIdentifier";

export type Point = [t: number, lat: number, lon: number, alt: number | null];

export interface RouteRow {
  start_at: string;
  end_at: string;
  meta: string | null;
}

export interface RouteStats {
  km: number;
  // Seconds for each full kilometer, in order.
  splits: number[];
  // The final segment under a kilometer: meters and seconds.
  rest: { meters: number; seconds: number } | null;
  climbM: number | null;
  descentM: number | null;
}

export function parsePoints(meta: string | null): Point[] {
  try {
    const points = (JSON.parse(meta ?? "{}") as { points?: Point[] }).points;
    return Array.isArray(points) ? points.filter((p) => Array.isArray(p) && p.length >= 3) : [];
  } catch {
    return [];
  }
}

// A workout's route: starts within a minute of the start and ends before the end.
export function routeFor<T extends RouteRow>(routes: T[], start: string, end: string): T | null {
  const from = Date.parse(start) - 60_000;
  const to = Date.parse(end) + 60_000;
  return routes.find((r) => Date.parse(r.start_at) >= from && Date.parse(r.start_at) <= to) ?? null;
}

export function routeStats(points: Point[]): RouteStats | null {
  if (points.length < 2) return null;
  const splits: number[] = [];
  let total = 0;
  let nextKm = 1000;
  let lastSplitAt = points[0][0];
  for (let i = 1; i < points.length; i++) {
    const step = distance(points[i - 1], points[i]);
    if (step > 200) continue; // GPS jump (signal lost): doesn't count
    const before = total;
    total += step;
    while (total >= nextKm) {
      // Exact kilometer instant, interpolated between the two points.
      const fraction = step ? (nextKm - before) / step : 0;
      const at = points[i - 1][0] + fraction * (points[i][0] - points[i - 1][0]);
      splits.push(at - lastSplitAt);
      lastSplitAt = at;
      nextKm += 1000;
    }
  }
  const last = points[points.length - 1][0];
  const restMeters = total - (nextKm - 1000);
  const { climb, descent } = elevation(points);
  return {
    km: total / 1000,
    splits,
    rest: restMeters >= 100 ? { meters: restMeters, seconds: last - lastSplitAt } : null,
    climbM: climb,
    descentM: descent,
  };
}

// "km splits 5:21, 5:15, 5:30 (last 420 m at 5:40 /km)".
export function describeSplits(stats: RouteStats): string | null {
  if (!stats.splits.length) return null;
  const list = stats.splits.map(pace).join(", ");
  const rest = stats.rest ? ` (last ${Math.round(stats.rest.meters)} m at ${pace(stats.rest.seconds * 1000 / stats.rest.meters)} /km)` : "";
  return `km splits ${list}${rest}`;
}

export function pace(secondsPerKm: number): string {
  const total = Math.round(secondsPerKm);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// Elevation with 3-meter tolerance: GPS altitude constantly fluctuates.
function elevation(points: Point[]): { climb: number | null; descent: number | null } {
  const altitudes = points.map((p) => p[3]).filter((a): a is number => typeof a === "number");
  if (altitudes.length < 2) return { climb: null, descent: null };
  let climb = 0;
  let descent = 0;
  let reference = altitudes[0];
  for (const a of altitudes) {
    if (a - reference >= 3) {
      climb += a - reference;
      reference = a;
    } else if (reference - a >= 3) {
      descent += reference - a;
      reference = a;
    }
  }
  return { climb: Math.round(climb), descent: Math.round(descent) };
}

function distance(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[2] - a[2]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

export function gpx(name: string, startAt: string, points: Point[]): string {
  const start = Date.parse(startAt);
  const trkpts = points.map(([t, lat, lon, alt]) => {
    const ele = typeof alt === "number" ? `<ele>${alt}</ele>` : "";
    const time = new Date(start + t * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    return `<trkpt lat="${lat}" lon="${lon}">${ele}<time>${time}</time></trkpt>`;
  });
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<gpx version="1.1" creator="HealthBridge" xmlns="http://www.topografix.com/GPX/1/1">`,
    `<trk><name>${escapeXml(name)}</name><trkseg>`,
    ...trkpts,
    `</trkseg></trk></gpx>`,
  ].join("\n");
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
