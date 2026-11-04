// HealthBridge, collection point on Cloudflare Workers + D1.
// * POST /ingest: receives new samples, deleted ones, and daily totals from the app.
// * GET /summary: summary, in text (or JSON with ?format=json). Used by the app.
// * GET /link/<SHARE_TOKEN>: same summary (14 days) for the ChatGPT coach, which
//   opens it from the link written in its project instructions.
// * GET /data/<SHARE_TOKEN>/: charts, latest workouts and exports (CSV, calendars,
//   GPX, JSON for Home Assistant). See dashboard.ts and exports.ts.
// * GET /status: last upload from phone, last read from link, and latest values
//   (used by the widget).
// * GET/POST/DELETE /automations: automations, managed by the app (automations.ts).
// * GET /a/<token>: private link of an automation, with only selected categories.
// * POST /calendar: commitments (times only) and planned workouts, from the app (calendar.ts).
// * POST /training: sessions recorded in the app, set by set (training.ts).
// * POST /maintenance and 03:30 cron: daily history and cleanup (maintenance.ts).
// * Hourly cron: automation webhook deliveries.
//
// The /ingest body is never read here: it's passed whole to D1, which parses it
// with SQLite JSON functions. This keeps the Worker under 10 ms CPU on the
// free plan even with thousands of samples per upload.

import { automationLog, deleteAutomation, listAutomations, runAutomation, runDueAutomations, saveAutomation, serveLink } from "./automations";
import { receiveCalendar } from "./calendar";
import { receiveTraining } from "./training";
import { dashboard } from "./dashboard";
import { dailyCsv, latest, sleepIcs, workoutGpx, workoutsCsv, workoutsIcs } from "./exports";
import { maintenance } from "./maintenance";
import { buildSummary, renderSummary } from "./summary";
import { addDays, isoSeconds, localDay } from "./time";

const MAINTENANCE_CRON = "30 3 * * *";

export interface Env {
  DB: D1Database;
  INGEST_TOKEN: string;
  READ_TOKEN: string;
  SHARE_TOKEN: string;
}

// D1 accepts parameters up to 2,000,000 bytes: we keep margin.
const MAX_BODY_BYTES = 1_900_000;

const INSERT_SAMPLES = `
INSERT OR REPLACE INTO samples (uuid, type, start_at, end_at, value, unit, source, meta)
SELECT json_extract(value, '$.uuid'), json_extract(value, '$.type'),
       json_extract(value, '$.start'), json_extract(value, '$.end'),
       json_extract(value, '$.value'), json_extract(value, '$.unit'),
       json_extract(value, '$.source'), json_extract(value, '$.meta')
FROM json_each(?1, '$.samples')`;

const DELETE_SAMPLES = `
DELETE FROM samples WHERE uuid IN (SELECT value FROM json_each(?1, '$.deleted'))`;

const UPSERT_DAILY = `
INSERT OR REPLACE INTO daily (day, metric, value, unit)
SELECT json_extract(value, '$.day'), json_extract(value, '$.metric'),
       json_extract(value, '$.value'), json_extract(value, '$.unit')
FROM json_each(?1, '$.daily')`;

const UPSERT_PROFILE = `
INSERT OR REPLACE INTO profile (key, value)
SELECT key, CAST(value AS TEXT) FROM json_each(?1, '$.profile')
WHERE json_type(?1, '$.profile') = 'object' AND value IS NOT NULL`;

const LOG_INGEST = `
INSERT INTO ingests (received_at, samples, deleted, daily)
VALUES (?2,
        coalesce(json_array_length(?1, '$.samples'), 0),
        coalesce(json_array_length(?1, '$.deleted'), 0),
        coalesce(json_array_length(?1, '$.daily'), 0))`;

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const now = new Date();
    if (controller.cron === MAINTENANCE_CRON) {
      const result = await maintenance(env.DB, now);
      // The automation runs log keeps 60 days.
      await env.DB.prepare("DELETE FROM automation_runs WHERE at < ?1").bind(`${addDays(localDay(now), -60)}T00:00:00Z`).run();
      console.log("maintenance:", JSON.stringify(result));
      return;
    }
    console.log("automations sent:", await runDueAutomations(env.DB, now));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/ingest" && request.method === "POST") {
        if (!authorized(request, env.INGEST_TOKEN)) return text("unauthorized", 401);
        return await ingest(request, env);
      }
      if (url.pathname === "/training" && request.method === "POST") {
        if (!authorized(request, env.INGEST_TOKEN)) return text("unauthorized", 401);
        const length = Number(request.headers.get("content-length"));
        if (!length) return text("Content-Length header required", 411);
        if (length > MAX_BODY_BYTES) return text("body too large", 413);
        return await receiveTraining(env.DB, await request.text());
      }
      if (url.pathname === "/calendar" && request.method === "POST") {
        if (!authorized(request, env.INGEST_TOKEN)) return text("unauthorized", 401);
        const length = Number(request.headers.get("content-length"));
        if (!length) return text("Content-Length header required", 411);
        if (length > MAX_BODY_BYTES) return text("body too large", 413);
        return await receiveCalendar(env.DB, await request.text());
      }
      if (url.pathname === "/summary" && request.method === "GET") {
        if (!authorized(request, env.READ_TOKEN)) return text("unauthorized", 401);
        return await summary(request, url, env, "app");
      }
      // After the token any suffix is accepted (/link/<token>/2026-10-08-0950): it's
      // the same summary, but with a fresh address that ChatGPT's cache doesn't have.
      if (url.pathname.startsWith("/link/") && request.method === "GET") {
        if (!sameSecret(url.pathname.slice("/link/".length).split("/")[0], env.SHARE_TOKEN)) return text("not found", 404);
        const response = await summary(request, url, env, "link", 14);
        // The link is private: no search engines, no intermediate caches.
        response.headers.set("x-robots-tag", "noindex, nofollow");
        response.headers.set("cache-control", "no-store");
        return response;
      }
      if (url.pathname.startsWith("/data/") && request.method === "GET") {
        const [, , token, ...rest] = url.pathname.split("/");
        if (!sameSecret(token, env.SHARE_TOKEN)) return text("not found", 404);
        const response = await data(rest.join("/"), `/data/${token}`, env.DB);
        response.headers.set("x-robots-tag", "noindex, nofollow");
        response.headers.set("cache-control", "no-store");
        return response;
      }
      if (url.pathname.startsWith("/a/") && request.method === "GET") {
        return await serveLink(request, env.DB, url.pathname.slice("/a/".length).split("/")[0]);
      }
      if (url.pathname === "/automations" || url.pathname.startsWith("/automations/")) {
        if (!authorized(request, env.INGEST_TOKEN)) return text("unauthorized", 401);
        return await automations(request, url, env.DB);
      }
      if (url.pathname === "/maintenance" && request.method === "POST") {
        if (!authorized(request, env.INGEST_TOKEN)) return text("unauthorized", 401);
        return Response.json(await maintenance(env.DB, new Date()));
      }
      if (url.pathname === "/status" && request.method === "GET") {
        if (!authorized(request, env.READ_TOKEN)) return text("unauthorized", 401);
        return Response.json(await status(env.DB));
      }
      return text("not found", 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("error:", message);
      // Malformed JSON or missing fields are an app error: 400.
      // Everything else (D1 unreachable, daily limit) is temporary:
      // 503, and the app retries on the next cycle without losing anything.
      const status = /malformed JSON|constraint/i.test(message) ? 400 : 503;
      return text(`error: ${message.slice(0, 300)}`, status);
    }
  },
};

async function ingest(request: Request, env: Env): Promise<Response> {
  const length = Number(request.headers.get("content-length"));
  if (!length) return text("Content-Length header required", 411);
  if (length > MAX_BODY_BYTES) return text("body too large", 413);

  const body = await request.text();
  const [samples, deleted, daily] = await env.DB.batch([
    env.DB.prepare(INSERT_SAMPLES).bind(body),
    env.DB.prepare(DELETE_SAMPLES).bind(body),
    env.DB.prepare(UPSERT_DAILY).bind(body),
    env.DB.prepare(UPSERT_PROFILE).bind(body),
    env.DB.prepare(LOG_INGEST).bind(body, isoSeconds(new Date())),
  ]);
  return Response.json({
    samples: samples.meta.changes,
    deleted: deleted.meta.changes,
    daily: daily.meta.changes,
  });
}

// Each read is logged with who made it: this is how we see if the ChatGPT coach
// actually opened the link.
// The coach link has no "?days=": query parameters cause issues with ChatGPT tools,
// so the default period there is already 14 days.
async function summary(request: Request, url: URL, env: Env, client: "app" | "link", defaultDays = 7): Promise<Response> {
  const days = Math.min(Math.max(Number(url.searchParams.get("days")) || defaultDays, 1), 31);
  const userAgent = (request.headers.get("user-agent") ?? "").slice(0, 200);
  const path = url.pathname.replace(env.SHARE_TOKEN, "<t>").slice(0, 200);
  const [result] = await Promise.all([
    buildSummary(env.DB, days, new Date()),
    env.DB.prepare("INSERT INTO summary_reads (read_at, days, client, user_agent, path) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(isoSeconds(new Date()), days, client, userAgent, path).run(),
  ]);
  if (url.searchParams.get("format") === "json") return Response.json(result);
  return text(renderSummary(result));
}

async function automations(request: Request, url: URL, db: D1Database): Promise<Response> {
  const [, , id, action] = url.pathname.split("/");
  if (!id && request.method === "GET") return Response.json(await listAutomations(db, url.origin));
  if (!id && request.method === "POST") return await saveAutomation(db, await request.json(), url.origin);
  if (id && !action && request.method === "DELETE") return await deleteAutomation(db, id);
  if (id && action === "run" && request.method === "POST") return await runAutomation(db, id);
  if (id && action === "log" && request.method === "GET") return Response.json(await automationLog(db, id));
  return text("not found", 404);
}

// Reads of these pages aren't logged: Calendar and Home Assistant request them
// continuously and would fill summary_reads.
async function data(path: string, base: string, db: D1Database): Promise<Response> {
  const now = new Date();
  if (path === "") return html(await dashboard(db, base, now));
  if (path === "daily.csv") return file(await dailyCsv(db), "text/csv", "healthbridge-daily.csv");
  if (path === "workouts.csv") return file(await workoutsCsv(db), "text/csv", "healthbridge-workouts.csv");
  if (path === "workouts.ics") return file(await workoutsIcs(db, now), "text/calendar");
  if (path === "sleep.ics") return file(await sleepIcs(db, now), "text/calendar");
  if (path === "latest.json") return Response.json(await latest(db, now));
  const gpx = path.match(/^gpx\/([0-9A-Fa-f-]{36})$/);
  if (gpx) {
    const body = await workoutGpx(db, gpx[1]);
    return body ? file(body, "application/gpx+xml", `workout-${gpx[1].slice(0, 8)}.gpx`) : text("route not found", 404);
  }
  return text("not found", 404);
}

// Only reads from the last row down: no counts on the entire table, which
// would grow daily (free plan has 5 million rows read per day).
async function status(db: D1Database) {
  const [ingest, link] = await db.batch([
    db.prepare("SELECT received_at AS at FROM ingests ORDER BY id DESC LIMIT 1"),
    // Only ChatGPT: link previews (when the link is pasted) don't count.
    db.prepare("SELECT read_at AS at, user_agent AS userAgent FROM summary_reads WHERE client = 'link' AND user_agent LIKE '%ChatGPT-User%' ORDER BY id DESC LIMIT 1"),
  ]);
  return {
    lastIngest: ingest.results[0] ?? null,
    lastLinkRead: link.results[0] ?? null,
    latest: await latest(db, new Date()),
  };
}

function authorized(request: Request, secret: string | undefined): boolean {
  const header = request.headers.get("authorization") ?? "";
  return sameSecret(header.startsWith("Bearer ") ? header.slice(7) : "", secret);
}

function sameSecret(given: string, secret: string | undefined): boolean {
  if (!secret) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(secret);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

function html(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function file(body: string, type: string, filename?: string): Response {
  const headers: Record<string, string> = { "content-type": `${type}; charset=utf-8` };
  if (filename) headers["content-disposition"] = `attachment; filename="${filename}"`;
  return new Response(body, { headers });
}

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
