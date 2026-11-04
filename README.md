# HealthBridge

An iPhone app plus a small Cloudflare Worker that turn your Apple Health data into a private, always-fresh summary that any AI assistant able to open a URL can read. No subscriptions, no third-party apps, no servers to run at home: the free tiers of Cloudflare Workers and D1 are enough for one person.

[Leggi in italiano](README.it.md)

```
Apple Watch / iPhone → Health → HealthBridge app → Cloudflare Worker + D1 → private link → your AI coach
```

## What it does

- **Automatic upload.** The app registers HealthKit observers: iOS wakes it when new data arrives (sleep and workouts right away, frequent data such as heart rate at most once an hour) and it sends only what is new. It also syncs on every launch and asks iOS for a background refresh every 30 minutes.
- **Almost everything in Health.** Workouts with Apple's statistics, laps, segments, metadata and GPS routes; heart rate, HRV, resting HR, VO2 max, sleep stages, respiration, oxygen, wrist temperature; running, swimming, cycling and diving metrics; body measurements, nutrition, water, caffeine, symptoms, mood (State of Mind), Apple Watch alerts, ECG classification, supplements and medications (dose taken or skipped). Only menstrual cycle, sexual activity, wheelchair and insulin data are left out.
- **A private summary for your coach.** `/link/<SHARE_TOKEN>` returns a plain-text page: the last 14 days day by day, averages compared with the previous period, every workout with heart rate halves, km splits, elevation and swimming pace/SWOLF, sleep, supplements, mood, the long-term history and your free time in the calendar. The first line says when the page was generated, to the second.
- **Charts and exports.** `/data/<SHARE_TOKEN>/` is a web page with charts (30 days, 90 days, a year, everything by month) and the last 40 workouts, plus `daily.csv`, `workouts.csv`, a GPX file per outdoor workout, two subscribable calendars (`workouts.ics`, `sleep.ics`) and `latest.json` for Home Assistant.
- **Automations.** Named data packages built from 13 categories (sleep, heart, workouts, nutrition...), each one either a private link of its own or a webhook POST every 1 to 24 hours sent by the Worker's cron, so it works even when the phone is locked.
- **Calendar planning.** With full calendar access the app sends your busy times for the next 14 days (start and end only, never titles), so the coach can plan workouts in your free slots. The coach ends a plan with a `PLAN` ... `END` block; the app imports it into a "Workouts" calendar and checks afterwards which planned sessions you actually did.
- **Training diary.** The plan's exercises become a session you log set by set (reps or seconds, weight, rest timer, "last time" for each exercise), with a Live Activity on the Lock Screen whose buttons work without unlocking. Sessions go to the server and the coach sees them.
- **Water tracker.** Log glasses from the app, a Home Screen widget with buttons, a Control Center control or the Shortcuts action; each glass is written to Health. 60-day history, editable past days, a daily goal the coach can see.
- **Status widget.** Small, medium and Lock Screen widgets showing whether uploads are flowing, when the coach last read the data, and today's sleep, resting HR, HRV and steps.
- **Morning briefing feed (optional).** The app can send your rounded location, upcoming events with titles, Contacts birthdays and a Reminders list to a briefing service of your own (for example a bot that messages you every morning). See [Morning briefing](#morning-briefing-optional).

## Architecture

| Piece | Where | What it does |
|---|---|---|
| iOS app | `HealthBridge/` | HealthKit observers and anchored queries, upload in batches of 2,000, calendar, water, training diary, automations screen, briefing feed |
| Widget extension | `HealthBridgeWidget/` | Status widget, water widget and control, training Live Activity |
| Shared code | `Shared/` | Compiled into both targets: server status, water queue (App Group), Live Activity intents, generated `Secrets.swift` |
| Worker | `server/src/` | Ingest, summary, charts page, exports, automations, nightly maintenance. Details in [server/README.md](server/README.md) |
| Database | Cloudflare D1 | Raw samples (frequent ones kept 90 days), permanent daily history, workouts forever, read log |

How the upload works:

1. One `HKObserverQuery` per data type with background delivery. When new data arrives iOS wakes the app, even if it is closed.
2. One `HKAnchoredObjectQuery` per type returns only new and deleted samples since the last upload. The anchor is saved only after the server answers OK: if the upload fails, the data waits for the next round.
3. At most every 30 minutes the app also sends the daily totals of the last 3 days (steps, energy, distance, exercise...) computed by HealthKit, which removes the iPhone and Watch duplicates.
4. Every night at 03:30 UTC the Worker computes daily values (resting HR, HRV, sleep, VO2 max, weight...) into the permanent `daily` table and deletes frequent samples older than 90 days. The database grows by a few MB a year.

On the first sync the app sends the last 14 days. The history section fills up from then on.

## Requirements

- An iPhone with iOS 27 or later (the minimum is set by HRV RMSSD and the Medications API), ideally with an Apple Watch.
- A Mac with Xcode 27 and an Apple ID. A free account works: background delivery is included in the free profile, but the app has to be re-signed every 7 days (see [Keeping the app installed](#keeping-the-app-installed)).
- A free Cloudflare account and a current Node.js LTS (for `wrangler`).

## Setup from zero

### 1. Server (Cloudflare Worker + D1)

From the `server/` folder:

```sh
npm install
npx wrangler login
npx wrangler d1 create health-bridge-db --jurisdiction eu   # drop --jurisdiction to pick any region
```

Paste the printed `database_id` into `server/wrangler.jsonc`, then:

```sh
npm run db:remote                      # applies the migrations
cp .secrets.example .secrets           # fill in three tokens: openssl rand -hex 16
npx wrangler secret put INGEST_TOKEN   # paste the same values as in .secrets
npx wrangler secret put READ_TOKEN
npx wrangler secret put SHARE_TOKEN
npm run deploy
```

Put the Worker address printed by `deploy` (for example `https://health-bridge.<your-subdomain>.workers.dev`) in `SERVER_URL` inside `.secrets`.

The server counts days in the `Europe/Rome` time zone. If you live elsewhere, change `TIME_ZONE` and the fast offset function in `server/src/time.ts` (it implements the Central European summer time rule).

### 2. App (Xcode)

1. Change the identifiers from `com.example.healthbridge` to your own reverse domain, everywhere at once:

   ```sh
   grep -rl com.example.healthbridge --include='*.pbxproj' --include='*.plist' --include='*.entitlements' --include='*.swift' --include='*.sh' . \
     | xargs sed -i '' 's/com\.example\.healthbridge/com.yourname.healthbridge/g'
   ```

   This covers the bundle ids of the app and the widget, the App Group (`group.com.yourname.healthbridge`) and the background task id.
2. Generate the secrets file the app compiles: `scripts/make-secrets.sh` (it reads `server/.secrets` and writes `Shared/Secrets.swift`, ignored by git).
3. Open `HealthBridge.xcodeproj`, select both targets (HealthBridge and HealthBridgeWidgetExtension), Signing & Capabilities, and pick your team. Xcode creates the App Group the first time.
4. Connect the iPhone and press Run.
5. With a free account: on the iPhone, Settings, General, VPN & Device Management, your Apple ID, Trust.
6. In the app tap **Sync now** and grant access to all data types. Then **Choose supplements and medications** if you track them in Health, and **Connect the calendar** if you want planning.

The simulator never uploads anything (`#if targetEnvironment(simulator)`), so a test session cannot end up in your real data.

### 3. Check that it works

- In the app: the status row says "All good" with the time of the last upload.
- `curl -H "Authorization: Bearer $READ_TOKEN" $SERVER_URL/status` returns the last upload and the latest values.
- Open `$SERVER_URL/link/$SHARE_TOKEN` in a browser: that is exactly what the coach reads.

## Using the link with an AI assistant

The link is meant for an assistant that can open web pages, set up once in a project or a custom assistant's instructions, so every conversation starts with fresh data and you never paste anything.

1. Copy your link: `$SERVER_URL/link/$SHARE_TOKEN` (14 days by default; `/summary?days=N` with the read token goes from 1 to 31).
2. Put it in the instructions of a project, with a few lines like the template in [docs/assistant-instructions.md](docs/assistant-instructions.md): open the link before every answer, use only those numbers, say when data is missing.
3. Ask your questions. The app shows "Last read by the coach" so you can tell whether the assistant really opened the link.

What was tested (ChatGPT, October 2026):

- ChatGPT opens the link from a project's instructions, with the user agent `ChatGPT-User/1.0`. The server logs every read with its user agent; "Last read by the coach" counts only that user agent, because pasting a link in a chat also triggers preview fetches.
- Keep the link short and without `?`: a longer link with a query string failed with "Invalid URL" before reaching the server.
- ChatGPT's web tool shows the copy saved at its *previous* visit and downloads the new one for the next time. The template therefore asks the assistant to open the link twice and use the second copy, and the page states when it was generated. Starting a new chat each day helps too.
- Other assistants were not tested: any tool that can fetch a URL should work the same way. For programs, `?format=json` on `/summary` returns the same data as JSON.

Anyone who has the link can read the summary. Keep it only in the assistant's instructions; if it leaks, change `SHARE_TOKEN` (see the [server README](server/README.md)).

## Features in detail

### Charts, exports and widget

All behind the share token, at `$SERVER_URL/data/<SHARE_TOKEN>/` (in the app: **Charts & exports**):

- **Charts:** sleep with stages, resting HR, HRV, steps, energy, exercise, VO2 max, weight, respiration, daylight, water; plus the last 40 workouts.
- **CSV:** `daily.csv` (one day per row) and `workouts.csv`.
- **GPX:** `gpx/<workout uuid>`, linked from the workouts table.
- **Calendars:** `workouts.ics` (last 2 years) and `sleep.ics` (last 90 nights). Tap the link on the iPhone and confirm Subscribe.
- **Home Assistant:** `latest.json` with the latest values, flat. The page has a ready `rest:` sensor example.
- **Widget:** long-press the Home Screen, Edit, Add Widget, HealthBridge. Green when the last upload is less than 3 hours old.

### Automations

In the app: **Automations**, **+**, with three presets (Health, Sport, Other). Each automation has:

- **categories:** one or more of the 13 in `server/src/categories.ts`;
- **period:** today, 7, 14 or 31 days;
- **format:** text (for assistants) or JSON (for programs and Home Assistant);
- **destination:** a private link `/a/<token>` (the app copies the link and ready-made instructions), or a webhook: a POST to an `https://` address every 1, 3, 6, 12 or 24 hours, with an optional header for a token.

The Worker sends the webhooks from its hourly cron, not the phone, so they go out even with the phone locked. Each automation keeps a log of reads or deliveries. A filtered page tells its reader that the other data is not included, so the assistant does not mistake it for missing data. The main link always contains everything.

### Calendar and the coach's plan

- **Reading:** with full access (**Connect the calendar**), at most every 15 minutes the app sends the events of all calendars for the next 14 days: start and end only, never titles. Birthdays, events marked free, declined invitations and all-day events not marked busy are left out.
- **On the page:** for each day, busy times, free slots of at least 45 minutes between 06:30 and 22:00, and planned workouts; for the past 14 days, which planned workouts were done (a workout the same day within 3 hours).
- **Writing:** the coach ends each plan with a block like this:

  ```
  PLAN
  2026-10-15 18:30 | 60 | Lower body strength | notes
  > Squat | 4x8 | 60 kg | 120 s
  > Plank | 3x45 s | bodyweight | 60 s
  END
  ```

  One line per session (`date time | minutes | title | notes`), and under it one line per exercise starting with `>` (`name | sets x reps | weight | rest | notes`; also `4xmax`, `3x45 s`). Copy it, then **Import the coach's plan**, Paste: the app shows a preview, creates the events in a "Workouts" calendar (on iCloud if available) and loads the exercises into the training section. A new plan replaces the planned workouts from its first day onward. Lines outside the format are ignored, so you can copy the whole answer.

### Training diary

- From the next planned session (or a free workout) you log set by set. Reps or seconds and weight are prefilled (the last set you did, otherwise the plan, otherwise last time) and change with + and −. **Set done** starts the plan's rest timer (90 seconds if none).
- **Last time** shows the sets of the last session with the same exercise (same name, ignoring case and spaces).
- During a session a Live Activity shows exercise, set, suggested values, rest and last time, with + and −, **Set done** and **Next** buttons that work on the Lock Screen (`TrainingActionIntent` in `Shared/TrainingActivity.swift`, executed in the app process).
- Data lives on the phone in `training.json` (Application Support). After each change the app sends the last 60 sessions to `POST /training`; the coach sees every set and the best weight for each exercise.
- The Watch keeps recording the workout (heart rate, calories): HealthBridge never writes workouts to Health, to avoid duplicates.

### Water

- **Water today** in the app: +250 or +500 ml, Undo for the last glass, a daily goal (2.5 L by default). The **Water** widget (Home Screen with buttons, Lock Screen with progress), the **Log water** control in Control Center and the Shortcuts action log without opening the app.
- Each glass is written to Health as `dietaryWater`, the only data HealthBridge writes. If Health refuses (phone locked, permission not given yet) the glass waits in the App Group queue and the app writes it later with the right time (`Shared/Water.swift`).
- **History:** last 60 days with total, glasses and goal reached; each day opens to add glasses after the fact or delete them (only those written by HealthBridge). After a correction the app resends the daily totals from that day, so the coach sees the corrected day too.

### Supplements and medications

1. In Health, Browse, Medications, add each supplement or medication with its schedule.
2. In the app, **Choose supplements and medications** and enable those to share. When you add a new one, Health itself asks whether to share it with HealthBridge.
3. Log doses from the Health notification. The summary counts taken, skipped and not logged doses for each one, and `/summary?format=json` lists them one by one (`extras.doses`).

### Morning briefing (optional)

HealthBridge can feed a morning briefing service you run yourself (for example a Worker that sends you a message with weather, agenda and sleep). The app sends only what the iPhone knows; the briefing can read sleep and water from `/summary?format=json` with the read token or a service binding. The briefing data never goes to the health server or the coach.

Set `BRIEFING_URL` and `BRIEFING_TOKEN` in `server/.secrets`, run `scripts/make-secrets.sh` and rebuild. Every request is a JSON `POST` with `Authorization: Bearer <BRIEFING_TOKEN>` and must answer `200`:

| Path | When | Body |
|---|---|---|
| `/location` | when you move (iOS significant changes, needs Always access) and on every launch, at most every 30 minutes unless you moved 1 km | `{ latitude, longitude, name, at }`, coordinates rounded to 0.01° (about 1 km), `name` is the city |
| `/agenda` | on every launch, and on background syncs at most every 15 minutes, before the health data | `{ lists, allLists, calendars, events, reminders }`: events of all calendars for the next 7 days with titles, Contacts birthdays, open reminders of the wanted lists, the names of all lists. Answer `{ "lists": ["..."] }` to choose which Reminders lists the app sends next time |
| `/wake` | from the **Update the briefing** Shortcuts action | `{}`, sent after the health data, agenda and reminders, so the briefing can go out right after you wake up |

In the app: Health, **Morning briefing**, **Connect location** and **Connect Reminders**. Without a token the app sends nothing and the section says the token is missing. A failure here never blocks the health upload. Code in `HealthBridge/Briefing/`.

## Keeping the app installed

With a free Apple ID the signature lasts 7 days. `scripts/renew.sh` deletes the old provisioning profiles, rebuilds with `-allowProvisioningUpdates` and reinstalls over Wi-Fi; data and settings stay.

```sh
DEVICE_ID=<id from: xcrun devicectl list devices> scripts/renew.sh --force
```

Without `--force` it renews only after 5 days, so you can run it every few hours from a LaunchAgent. It notifies on the Mac from day 6 if it fails, and states the cause (Mac locked, iPhone not reachable, Xcode without account, build failed). The last build output is in `~/Library/Application Support/HealthBridge/last-build.log`. It needs the Mac awake now and then, the iPhone on the same network, and your Apple ID still in Xcode, Settings, Accounts (an Xcode update can remove it). Don't run it with the screen locked: macOS closes the keychain and Xcode can lose the account.

With a paid developer account none of this is needed.

## Privacy

- Your data goes from the phone to your own Cloudflare account and nowhere else. There is no analytics, no third-party SDK, no account to create.
- The D1 database can be created with `--jurisdiction eu` to keep it in the European Union.
- Four secrets: `INGEST_TOKEN` (write), `READ_TOKEN` (read, used by the app and widget), `SHARE_TOKEN` (the coach link and the charts page, in the URL) and the optional `BRIEFING_TOKEN`. They live in `server/.secrets`, in the Worker's secrets and in the generated `Shared/Secrets.swift`, all ignored by git.
- Whoever has the share link can read your summary. Treat it like a password. The AI provider you give it to will read your health data: check its data policy.
- Calendar titles never reach the server or the coach, only start and end times. Titles, location and reminders go only to the briefing service you configure, if you configure one.
- Every read of the summary is logged with its user agent (`summary_reads`), so you can see who opened the link.
- Export everything at any time: `npx wrangler d1 export health-bridge-db --remote --output backup.sql`.

## Troubleshooting

- **The app no longer opens:** the 7-day signature expired. Run `scripts/renew.sh --force` with the iPhone on the same network.
- **"Signing requires a development team":** pick your team in both targets, and check that your Apple ID is in Xcode, Settings, Accounts.
- **Server errors 401 or 503:** see the [server README](server/README.md).
- **"Phone locked" as the last error:** normal if the last successful upload is recent. iOS encrypts Health data while the phone is locked; the next round catches up.
- **A data type denied by mistake:** Health, your profile, Apps, HealthBridge, enable it again.
- **The widget says the server is unreachable:** no network, or the read token changed (run `scripts/make-secrets.sh` and reinstall).

## Project structure

- `HealthBridge/SyncEngine.swift`: observers, anchored queries, upload.
- `HealthBridge/ContentView.swift`: main screen, upload status, last coach read, setup buttons.
- `HealthBridge/SummaryView.swift`: "What the coach sees", the summary downloaded from the server.
- `HealthBridge/AutomationsView.swift`: automations list and editor.
- `HealthBridge/CalendarBridge.swift`, `CalendarPlanView.swift`: busy times, Workouts calendar, plan import.
- `HealthBridge/Training/`: plan parser, session store, set-by-set screens, Live Activity commands.
- `HealthBridge/WaterSection.swift`, `WaterHistoryView.swift`: water today, history, past days.
- `HealthBridge/Briefing/`: location, agenda, reminders and the Shortcuts action for the optional briefing.
- `HealthBridgeWidget/`: status widget, water widget and control, training Live Activity.
- `Shared/`: code compiled into both targets; `Secrets.swift` is generated.
- `HealthBridge.entitlements`: HealthKit, background delivery, App Group.
- `server/`: the Worker, its migrations and its [README](server/README.md).
- `scripts/make-secrets.sh`: generates `Shared/Secrets.swift`. `scripts/renew.sh`: re-signs the app. `scripts/make-icon.swift`: draws the app icon.

The Xcode project uses synchronized folders: new Swift files inside `HealthBridge/`, `HealthBridgeWidget/` and `Shared/` join the project on their own.

## License

[MIT](LICENSE)
