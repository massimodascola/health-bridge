# HealthBridge server (Cloudflare Worker + D1)

Receives the Health data from the HealthBridge app, stores it in D1 and renders the summary, the charts page, the exports and the automations. Setup from zero is in the [main README](../README.md#1-server-cloudflare-worker--d1).

## Routes

| Route | Used by | Auth |
|---|---|---|
| `POST /ingest` | the app, on its own | `INGEST_TOKEN` (write) |
| `POST /training` | the app: sessions logged set by set (`src/training.ts`) | `INGEST_TOKEN` |
| `POST /calendar` | the app: busy times (no titles) and planned workouts (`src/calendar.ts`) | `INGEST_TOKEN` |
| `GET /automations`, `POST /automations`, `DELETE /automations/<id>` | the app, Automations screen (`src/automations.ts`) | `INGEST_TOKEN` |
| `POST /automations/<id>/run`, `GET /automations/<id>/log` | the app: send now, delivery log | `INGEST_TOKEN` |
| `POST /maintenance` | by hand: runs the nightly maintenance now | `INGEST_TOKEN` |
| `GET /summary` | the app, "What the coach sees"; `?days=1..31` (default 7), `?format=json` for programs | `READ_TOKEN` (read) |
| `GET /status` | the app and the widget: last upload, last coach read, latest values | `READ_TOKEN` |
| `GET /link/<SHARE_TOKEN>` | the AI coach: same summary, 14 days by default, no query string | token in the URL |
| `GET /data/<SHARE_TOKEN>/` | you, in a browser: charts, last workouts, exports (`src/dashboard.ts`) | token in the URL |
| `GET /data/<SHARE_TOKEN>/daily.csv`, `workouts.csv` | CSV exports (`src/exports.ts`) | same |
| `GET /data/<SHARE_TOKEN>/workouts.ics`, `sleep.ics` | calendars to subscribe to | same |
| `GET /data/<SHARE_TOKEN>/latest.json` | Home Assistant or other tools | same |
| `GET /data/<SHARE_TOKEN>/gpx/<uuid>` | GPS route of a workout | same |
| `GET /a/<token>` | an automation's private link: only its categories | token in the URL |

Tokens are compared in constant time. Reads of `/data/` are not logged in `summary_reads`, because calendars and Home Assistant poll them all the time. Reads of `/link/` and `/a/<token>` are, with their user agent and path.

## What the summary contains

`src/summary.ts` builds averages compared with the previous period, a day-by-day table and the workouts, with km splits and elevation from GPS (`src/routes.ts`) and pace per 100 m and SWOLF for swimming. The sections "Health and recovery", "Symptoms", "Other measured values", "Habits and nutrition" and "Supplements and medications" (`src/extras.ts`, names and units in `src/catalog.ts`) appear only when there is data. `src/history.ts` adds the long-term history from `daily`, the workouts and the `profile` table; `src/calendar.ts` the busy and free times and the planned workouts; `src/training.ts` the logged sessions.

Two HealthKit types don't follow the naming scheme of the others: mood arrives as `HKDataTypeStateOfMind`, medication doses as `HKMedicationDoseEventTypeIdentifierMedicationDoseEvent`.

The data is split into 13 categories (`src/categories.ts`). An automation picks some of them; without categories the text is exactly the main summary.

## Tables

- `samples` (`migrations/0001_schema.sql`): one HealthKit sample per row, keyed by its HealthKit UUID. A resend overwrites instead of duplicating.
- `daily`: daily totals computed on the phone (steps, energy, distance, exercise...) plus the values derived every night. They are not recomputed from samples because iPhone and Watch count the same steps. This is the permanent history.
- `ingests`: one row per upload, to see whether syncing works.
- `summary_reads` (`0002_coach.sql`, `0003_link.sql`, `0006_read_path.sql`): every read of the summary, with client, user agent and path.
- `profile` (`0004_profile.sql`): key and value, for date of birth, sex, height and the water goal.
- `automations` and `automation_runs` (`0005_automations.sql`): name, categories, period, format, destination; the result of each delivery, kept 60 days.
- `calendar_events` and `calendar_sync` (`0007_calendar.sql`): busy times and planned workouts.
- `training_sessions` and `training_sets` (`0008_training.sql`): sessions logged in the app.
- `coach_messages` (`0002_coach.sql`) is left over from an early version and is no longer used.

## History and cleanup

Every night at 03:30 UTC (the Worker's cron, or `POST /maintenance`) `src/maintenance.ts`:

1. computes the derived daily values of the last 100 days (resting HR, HRV, sleep with stages, respiratory rate, oxygen, VO2 max, weight) and saves them in `daily`;
2. deletes frequent samples (heart rate, energy, steps, running and walking metrics...) older than 90 days.

Workouts with their statistics, sleep and rare data stay forever, so the database grows by a few MB a year and stays in the free plan. The hourly cron at minute 15 sends the due webhook automations, at most 3 per run.

## Commands

From `server/`:

```sh
npm install
npm run check        # type check
npm run dev          # local server on http://localhost:8787 with a local database
npm run db:local     # apply the migrations to the local database
npm run db:remote    # apply the migrations to the real database
npm run deploy       # publish
```

Locally the tokens live in `.dev.vars` (copy `.dev.vars.example`). The real ones live in `.secrets` (copy `.secrets.example`) and as Worker secrets. Both files are ignored by git.

Read the data by hand:

```sh
npx wrangler d1 execute health-bridge-db --remote --command "SELECT type, count(*) FROM samples GROUP BY type"
```

Export everything (backup, or to leave Cloudflare):

```sh
npx wrangler d1 export health-bridge-db --remote --output backup.sql
```

## Free plan limits

From the Cloudflare docs, read on 2026-10-05 ([Workers](https://developers.cloudflare.com/workers/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/limits/)); check them again, they change:

- 100,000 requests a day, 10 ms of CPU per request. That is why `/ingest` does not parse the body: it hands it to D1, which splits it with SQLite's JSON functions. Averages, sums and CSV are computed by SQLite for the same reason, and days are computed without `Intl` (see `src/time.ts`).
- The coach summary takes more than 10 ms: 21 to 33 ms measured with `wrangler tail` (October 2026), with no request blocked for CPU in the Cloudflare statistics. If "exceeded CPU" errors ever appear, read fewer rows (see `buildSummary`).
- D1: 100,000 rows written a day, 5 million read, 500 MB per database, 50 queries per request.
- Each sample writes about 2 rows (table and index). One iPhone with an Apple Watch produced about 1,100 samples a day in testing.

## How it breaks and how to fix it

- **The app says the server answered 401:** the token in the app doesn't match the Worker's. Run `scripts/make-secrets.sh` again and reinstall the app.
- **The app says the server answered 503:** D1 did not answer, or the daily write limit is used up. Nothing is lost: the app retries on the next round. The limit resets at midnight UTC.
- **A token leaked:** generate a new one in `.secrets`, then `npx wrangler secret put <NAME>`. For `INGEST_TOKEN` and `READ_TOKEN` also regenerate `Secrets.swift` and reinstall the app. For `SHARE_TOKEN` update the link in your assistant's instructions, regenerate `Secrets.swift` (the "Charts & exports" link) and subscribe to the calendars again.
- **The database approaches 500 MB:** check with `npx wrangler d1 info health-bridge-db`. At about 2 rows per sample it takes years.
