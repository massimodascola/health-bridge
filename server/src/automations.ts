// Automations, modeled after Health Auto Export: named data packages,
// chosen by category (src/categories.ts), with period and format. Two destinations:
// * link: a private address /a/<token> to give to a ChatGPT project, Home
//   Assistant or similar. Each read is recorded, like the coach link;
// * webhook: the server sends data via POST to a web address every N hours
//   (scheduled cron in index.ts). The phone is not needed: the data is already here.
// The app manages them with the write token (GET/POST/DELETE /automations).

import { CATEGORIES, isCategory } from "./categories";
import { buildSummary, renderSummary, summaryJson } from "./summary";
import { isoSeconds } from "./time";

export interface AutomationRow {
  id: string;
  name: string;
  token: string;
  categories: string;
  days: number;
  format: "text" | "json";
  destination: "link" | "webhook";
  webhook_url: string | null;
  webhook_header: string | null;
  every_hours: number;
  enabled: number;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
}

const MAX_AUTOMATIONS = 20;
const EVERY_HOURS = [1, 3, 6, 12, 24];

export async function listAutomations(db: D1Database, origin: string) {
  const { results: rows } = await db.prepare("SELECT * FROM automations ORDER BY created_at").all<AutomationRow>();
  // Two queries per automation: last read and last send (D1: max 50 per request).
  const details = rows.length
    ? await db.batch(rows.flatMap((r) => [
        db.prepare("SELECT read_at AS at, user_agent FROM summary_reads WHERE client = ?1 ORDER BY id DESC LIMIT 1")
          .bind(`automation:${r.id}`),
        db.prepare("SELECT at, ok, detail FROM automation_runs WHERE automation_id = ?1 ORDER BY id DESC LIMIT 1").bind(r.id),
      ]))
    : [];
  return {
    categories: CATEGORIES,
    automations: rows.map((r, i) => {
      const read = details[i * 2]?.results[0] as { at: string; user_agent: string | null } | undefined;
      const run = details[i * 2 + 1]?.results[0] as { at: string; ok: number; detail: string | null } | undefined;
      return {
        ...describe(r, origin),
        last_read_at: read?.at ?? null,
        last_read_by: read ? reader(read.user_agent) : null,
        last_run_at: run?.at ?? null,
        last_run_ok: run ? !!run.ok : null,
        last_run_detail: run?.detail ?? null,
      };
    }),
  };
}

function describe(r: AutomationRow, origin: string) {
  return {
    id: r.id,
    name: r.name,
    categories: JSON.parse(r.categories) as string[],
    days: r.days,
    format: r.format,
    destination: r.destination,
    webhook_url: r.webhook_url,
    webhook_header: r.webhook_header,
    every_hours: r.every_hours,
    enabled: !!r.enabled,
    url: `${origin}/a/${r.token}`,
  };
}

// Who opened the link, based on the user agent.
function reader(userAgent: string | null): string {
  const ua = userAgent ?? "";
  if (ua.includes("ChatGPT-User")) return "ChatGPT";
  if (ua.includes("Claude")) return "Claude";
  if (ua.includes("HomeAssistant")) return "Home Assistant";
  if (ua.includes("HealthBridge") || ua.includes("CFNetwork")) return "app HealthBridge";
  if (ua.includes("Mozilla")) return "browser";
  return "other";
}

interface Input {
  id?: string;
  name: string;
  categories: string[];
  days: number;
  format: "text" | "json";
  destination: "link" | "webhook";
  webhook_url: string | null;
  webhook_header: string | null;
  every_hours: number;
  enabled: boolean;
}

// Validates input from the app. Returns the clean automation or the reason for rejection.
function validate(body: unknown): Input | string {
  if (!body || typeof body !== "object") return "invalid body";
  const b = body as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name || name.length > 60) return "name must be 1 to 60 characters";
  const categories = Array.isArray(b.categories) ? [...new Set(b.categories.filter(isCategory))] : [];
  if (!categories.length) return "choose at least one category";
  const days = Number(b.days);
  if (!Number.isInteger(days) || days < 1 || days > 31) return "period must be 1 to 31 days";
  const format = b.format === "json" ? "json" : "text";
  const destination = b.destination === "webhook" ? "webhook" : "link";
  let webhookUrl: string | null = null;
  let header: string | null = null;
  const everyHours = Number(b.every_hours ?? 24);
  if (destination === "webhook") {
    try {
      const url = new URL(String(b.webhook_url ?? ""));
      if (url.protocol !== "https:") return "address must start with https://";
      webhookUrl = url.toString();
    } catch {
      return "invalid web address";
    }
    if (!EVERY_HOURS.includes(everyHours)) return `invalid frequency (${EVERY_HOURS.join(", ")} hours)`;
    const rawHeader = typeof b.webhook_header === "string" ? b.webhook_header.trim() : "";
    if (rawHeader) {
      const colon = rawHeader.indexOf(":");
      const key = rawHeader.slice(0, colon).trim();
      const value = rawHeader.slice(colon + 1).trim();
      if (colon < 1 || !/^[A-Za-z0-9-]+$/.test(key) || !/^[\x20-\x7E]+$/.test(value) || rawHeader.length > 1000) {
        return "invalid header: write it as Name: value";
      }
      header = `${key}: ${value}`;
    }
  }
  return {
    id: typeof b.id === "string" && /^[0-9a-f]{8}$/.test(b.id) ? b.id : undefined,
    name, categories, days, format, destination,
    webhook_url: webhookUrl,
    webhook_header: header,
    every_hours: destination === "webhook" ? everyHours : 24,
    enabled: b.enabled !== false,
  };
}

export async function saveAutomation(db: D1Database, body: unknown, origin: string): Promise<Response> {
  const input = validate(body);
  if (typeof input === "string") return Response.json({ error: input }, { status: 400 });
  const now = isoSeconds(new Date());
  const values = [
    input.name, JSON.stringify(input.categories), input.days, input.format, input.destination,
    input.webhook_url, input.webhook_header, input.every_hours, input.enabled ? 1 : 0, now,
  ];
  let id = input.id;
  if (id) {
    const { meta } = await db.prepare(`UPDATE automations SET name = ?1, categories = ?2, days = ?3, format = ?4,
        destination = ?5, webhook_url = ?6, webhook_header = ?7, every_hours = ?8, enabled = ?9, updated_at = ?10
        WHERE id = ?11`).bind(...values, id).run();
    if (!meta.changes) return Response.json({ error: "automation not found" }, { status: 404 });
  } else {
    const count = await db.prepare("SELECT count(*) AS n FROM automations").first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_AUTOMATIONS) return Response.json({ error: `max ${MAX_AUTOMATIONS} automations` }, { status: 400 });
    id = randomHex(4);
    await db.prepare(`INSERT INTO automations (name, categories, days, format, destination, webhook_url,
        webhook_header, every_hours, enabled, created_at, updated_at, id, token)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11, ?12)`).bind(...values, id, randomHex(16)).run();
  }
  const row = await db.prepare("SELECT * FROM automations WHERE id = ?1").bind(id).first<AutomationRow>();
  return Response.json(describe(row!, origin));
}

export async function deleteAutomation(db: D1Database, id: string): Promise<Response> {
  const [deleted] = await db.batch([
    db.prepare("DELETE FROM automations WHERE id = ?1").bind(id),
    db.prepare("DELETE FROM automation_runs WHERE automation_id = ?1").bind(id),
  ]);
  return deleted.meta.changes ? Response.json({ deleted: id }) : Response.json({ error: "automation not found" }, { status: 404 });
}

export async function automationLog(db: D1Database, id: string) {
  const [runs, reads] = await db.batch([
    db.prepare("SELECT at, ok, detail FROM automation_runs WHERE automation_id = ?1 ORDER BY id DESC LIMIT 20").bind(id),
    db.prepare("SELECT read_at AS at, user_agent FROM summary_reads WHERE client = ?1 ORDER BY id DESC LIMIT 20")
      .bind(`automation:${id}`),
  ]);
  return {
    runs: (runs.results as { at: string; ok: number; detail: string | null }[])
      .map((r) => ({ at: r.at, ok: !!r.ok, detail: r.detail })),
    reads: (reads.results as { at: string; user_agent: string | null }[])
      .map((r) => ({ at: r.at, by: reader(r.user_agent) })),
  };
}

// The content of an automation: the summary with only the chosen categories.
async function content(db: D1Database, row: AutomationRow, now: Date): Promise<{ body: string; json: boolean }> {
  const categories = new Set(JSON.parse(row.categories) as string[]);
  const summary = await buildSummary(db, row.days, now, { categories });
  if (row.format === "json") {
    return { body: JSON.stringify({ automation: row.name, ...summaryJson(summary, categories) }), json: true };
  }
  return { body: renderSummary(summary, categories), json: false };
}

export async function serveLink(request: Request, db: D1Database, token: string): Promise<Response> {
  const row = await db.prepare("SELECT * FROM automations WHERE token = ?1 AND destination = 'link' AND enabled = 1")
    .bind(token).first<AutomationRow>();
  if (!row) return new Response("not found", { status: 404 });
  const now = new Date();
  const userAgent = (request.headers.get("user-agent") ?? "").slice(0, 200);
  const [result] = await Promise.all([
    content(db, row, now),
    db.prepare("INSERT INTO summary_reads (read_at, days, client, user_agent, path) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(isoSeconds(now), row.days, `automation:${row.id}`, userAgent, new URL(request.url).pathname.replace(token, "<t>").slice(0, 200)).run(),
  ]);
  return new Response(result.body, {
    headers: {
      "content-type": result.json ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
      "x-robots-tag": "noindex, nofollow",
      "cache-control": "no-store",
    },
  });
}

export async function runAutomation(db: D1Database, id: string): Promise<Response> {
  const row = await db.prepare("SELECT * FROM automations WHERE id = ?1").bind(id).first<AutomationRow>();
  if (!row) return Response.json({ error: "automation not found" }, { status: 404 });
  if (row.destination !== "webhook") return Response.json({ error: "only webhook automations can be run manually" }, { status: 400 });
  return Response.json(await sendWebhook(db, row, new Date()));
}

async function sendWebhook(db: D1Database, row: AutomationRow, now: Date): Promise<{ ok: boolean; detail: string }> {
  let ok = false;
  let detail: string;
  try {
    const result = await content(db, row, now);
    const body = result.json
      ? result.body
      : JSON.stringify({ automation: row.name, generatedAt: now.toISOString(), text: result.body });
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "HealthBridge/1.0",
      // Headers only accept ASCII: the name may have accents.
      "automation-name": encodeURIComponent(row.name),
    };
    if (row.webhook_header) {
      const colon = row.webhook_header.indexOf(":");
      headers[row.webhook_header.slice(0, colon).trim()] = row.webhook_header.slice(colon + 1).trim();
    }
    const response = await fetch(row.webhook_url!, { method: "POST", headers, body, signal: AbortSignal.timeout(20_000) });
    ok = response.ok;
    detail = `HTTP ${response.status}`;
  } catch (error) {
    detail = (error instanceof Error ? error.message : String(error)).slice(0, 200);
  }
  await db.batch([
    db.prepare("INSERT INTO automation_runs (automation_id, at, ok, detail) VALUES (?1, ?2, ?3, ?4)")
      .bind(row.id, isoSeconds(now), ok ? 1 : 0, detail),
    db.prepare("UPDATE automations SET last_run_at = ?2 WHERE id = ?1").bind(row.id, isoSeconds(now)),
  ]);
  return { ok, detail };
}

// From the scheduled cron: expired sends, max 3 per run (each builds a summary).
// Ten minutes of tolerance, so an "every hour" send doesn't skip a run due to a few seconds.
export async function runDueAutomations(db: D1Database, now: Date): Promise<number> {
  const { results } = await db.prepare(`SELECT * FROM automations
      WHERE enabled = 1 AND destination = 'webhook'
        AND (last_run_at IS NULL OR last_run_at <= strftime('%Y-%m-%dT%H:%M:%SZ', ?1, '-' || (every_hours * 60 - 10) || ' minutes'))
      ORDER BY last_run_at LIMIT 3`).bind(isoSeconds(now)).all<AutomationRow>();
  for (const row of results) await sendWebhook(db, row, now);
  return results.length;
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
