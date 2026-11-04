// Page with charts, latest workouts and export: /data/<token>/.
// Data arrives ready from SQLite and ends up in the page as JSON;
// charts are drawn by the browser with Chart.js.

import { DAILY_COLUMNS, dailySeries, latest, workoutLines, activityName } from "./exports";

export async function dashboard(db: D1Database, base: string, now: Date): Promise<string> {
  const [series, last, workouts] = await Promise.all([
    dailySeries(db),
    latest(db, now),
    workoutLines(db, "0000", 40),
  ]);
  const data = {
    metrics: DAILY_COLUMNS.map(([metric]) => metric),
    latest: last,
    workouts: workouts.map((w) => ({
      uuid: w.uuid, start: w.start_at, activity: activityName(w.activity), type: w.activity,
      minutes: Math.round(w.seconds / 60), km: w.meters ? w.meters / 1000 : null,
      kcal: w.kcal, hr: w.hr_avg, route: !!w.has_route,
    })),
  };
  // "<" encoded: no data text can close the <script> tag. Replacements
  // go through a function so a "$" in data is not interpreted.
  const safe = (text: string) => text.replace(/</g, "\\u003c");
  return PAGE
    .replace("__DATA__", () => safe(JSON.stringify(data)))
    .replace("__DAILY__", () => safe(series))
    .replaceAll("__BASE__", () => base);
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>HealthBridge</title>
<style>
:root {
  --bg: #f6f7f9; --card: #ffffff; --text: #1d2330; --muted: #667085; --line: #e4e7ec;
  --accent: #e5484d; --blue: #3e63dd; --green: #30a46c; --violet: #8e4ec6; --amber: #f5a524;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #111318; --card: #1a1d24; --text: #eceef2; --muted: #9ba1ad; --line: #2b2f38;
    --accent: #ff6369; --blue: #7b93ff; --green: #4cc38a; --violet: #b07ce8; --amber: #ffc53d;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width: 1080px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -0.02em; }
h2 { font-size: 17px; margin: 32px 0 12px; }
.muted { color: var(--muted); }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin-top: 20px; }
.tile, .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; }
.tile { padding: 12px 14px; }
.tile b { display: block; font-size: 22px; letter-spacing: -0.01em; margin-top: 2px; }
.tile span { font-size: 13px; color: var(--muted); }
.ranges { display: flex; gap: 6px; margin: 28px 0 12px; flex-wrap: wrap; }
.ranges button { font: inherit; padding: 6px 14px; border-radius: 999px; border: 1px solid var(--line);
  background: var(--card); color: var(--text); cursor: pointer; }
.ranges button[aria-pressed="true"] { background: var(--text); color: var(--bg); border-color: var(--text); }
.charts { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
.card { padding: 14px 14px 8px; }
.card h3 { font-size: 14px; margin: 0 0 8px; font-weight: 600; }
.plot { position: relative; height: 180px; }
.card .none { display: none; height: 180px; margin: 0; align-content: center; text-align: center; }
.card.empty .plot { display: none; }
.card.empty .none { display: grid; }
.table { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { color: var(--muted); font-weight: 500; font-size: 13px; }
a { color: var(--blue); }
ul.links { padding: 0; list-style: none; margin: 0; }
ul.links li { padding: 12px 14px; border-bottom: 1px solid var(--line); }
ul.links li:last-child { border-bottom: 0; }
pre { background: var(--bg); padding: 10px; border-radius: 8px; overflow-x: auto; font-size: 12px; }
@media (max-width: 400px) { .charts { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<main>
  <h1>HealthBridge</h1>
  <div class="muted" id="status"></div>
  <div class="tiles" id="tiles"></div>

  <div class="ranges" role="group" aria-label="Period">
    <button data-days="30">30 days</button>
    <button data-days="90" aria-pressed="true">90 days</button>
    <button data-days="365">1 year</button>
    <button data-days="0">All, by month</button>
  </div>
  <div class="charts" id="charts"></div>

  <h2>Latest workouts</h2>
  <div class="card table"><table id="workouts"></table></div>

  <h2>Export & links</h2>
  <div class="card"><ul class="links">
    <li><a href="__BASE__/daily.csv">Daily values (CSV)</a>
      <div class="muted">One day per row, from first data: steps, sleep with stages, resting HR, HRV, VO2 max, weight and more.</div></li>
    <li><a href="__BASE__/workouts.csv">Workouts (CSV)</a>
      <div class="muted">All workouts with duration, distance, calories and heart rate.</div></li>
    <li><a id="cal-workouts" href="#">Workouts calendar</a> · <a id="cal-sleep" href="#">Sleep calendar</a>
      <div class="muted">On iPhone or Mac tap the link and confirm "Subscribe": the calendar updates automatically every hour.</div></li>
    <li><a href="__BASE__/latest.json">Latest values (JSON)</a>
      <div class="muted">For Home Assistant or other tools. Example sensor for <code>configuration.yaml</code>:</div>
      <pre id="ha"></pre></li>
  </ul></div>
</main>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.5.0/chart.umd.min.js"></script>
<script>
const DATA = __DATA__;
const DAILY = __DAILY__;
const L = DATA.latest;
const col = (name) => DATA.metrics.indexOf(name) + 1;
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const num = (v, d = 0) => v == null ? "n/a" : v.toLocaleString("en-GB", { maximumFractionDigits: d });
const hm = (m) => m == null ? "n/a" : Math.floor(m / 60) + " h " + String(Math.round(m % 60)).padStart(2, "0");
const when = (iso) => iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "never";

document.getElementById("status").textContent =
  "Last upload from phone: " + when(L.updated_at) + " · Last read by the coach: " + when(L.coach_last_read);

const tiles = [
  ["Last night sleep", hm(L.sleep_minutes)],
  ["Resting HR", num(L.resting_hr) + " bpm"],
  ["HRV", num(L.hrv_ms) + " ms"],
  ["Steps today", num(L.steps_today)],
  ["Active energy today", num(L.active_energy_today) + " kcal"],
  ["VO2 max", num(L.vo2_max, 1)],
  ["Weight", L.weight_kg == null ? "n/a" : num(L.weight_kg, 1) + " kg"],
  ["Water today", L.water_today_ml == null ? "n/a" : num(L.water_today_ml / 1000, 1) + (L.water_goal_ml ? " / " + num(L.water_goal_ml / 1000, 1) : "") + " L"],
];
document.getElementById("tiles").innerHTML = tiles
  .map(([label, value]) => "<div class='tile'><span>" + label + "</span><b>" + value + "</b></div>").join("");

const CHARTS = [
  { title: "Sleep (hours)", kind: "bar", stacked: true, series: [
    ["Deep", (r) => r[col("sleepDeep")] / 60, "--violet"],
    ["REM", (r) => r[col("sleepRem")] / 60, "--blue"],
    ["Core", (r) => r[col("sleep")] != null && r[col("sleepDeep")] != null
      ? (r[col("sleep")] - r[col("sleepDeep")] - (r[col("sleepRem")] || 0)) / 60 : null, "--green"],
    ["Total (no stages)", (r) => r[col("sleepDeep")] == null && r[col("sleep")] != null ? r[col("sleep")] / 60 : null, "--muted"],
  ] },
  { title: "Resting HR (bpm)", series: [["Resting HR", (r) => r[col("restingHr")], "--accent"]] },
  { title: "HRV (ms)", series: [["SDNN", (r) => r[col("hrv")], "--violet"], ["RMSSD", (r) => r[col("hrvRmssd")], "--blue"]] },
  { title: "Steps", kind: "bar", series: [["Steps", (r) => r[col("steps")], "--green"]] },
  { title: "Active energy (kcal)", kind: "bar", series: [["Active energy", (r) => r[col("activeEnergy")], "--accent"]] },
  { title: "Exercise (min)", kind: "bar", series: [["Exercise", (r) => r[col("exerciseTime")], "--amber"]] },
  { title: "VO2 max", series: [["VO2 max", (r) => r[col("vo2Max")], "--blue"]] },
  { title: "Weight (kg)", series: [["Weight", (r) => r[col("bodyMass")], "--muted"]] },
  { title: "Sleep respiratory rate", series: [["Breaths per minute", (r) => r[col("respiratoryRate")], "--green"]] },
  { title: "Daylight (min)", kind: "bar", series: [["Daylight", (r) => r[col("daylight")], "--amber"]] },
  { title: "Water (liters)", kind: "bar", series: [["Water", (r) => r[col("water")], "--blue"]] },
];

const holder = document.getElementById("charts");
const instances = CHARTS.map((c) => {
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = "<h3>" + c.title + "</h3><div class='plot'><canvas></canvas></div><p class='none muted'>No data in period</p>";
  c.card = card;
  holder.appendChild(card);
  return new Chart(card.querySelector("canvas"), {
    type: c.kind || "line",
    data: { labels: [], datasets: c.series.map(([label, , color]) => ({
      label, data: [], borderColor: css(color), backgroundColor: css(color),
      pointRadius: 0, borderWidth: 2, spanGaps: true, tension: 0.25,
    })) },
    options: {
      animation: false, maintainAspectRatio: false,
      plugins: { legend: { display: c.series.length > 1, labels: { color: css("--muted"), boxWidth: 10 } } },
      scales: {
        x: { stacked: !!c.stacked, ticks: { color: css("--muted"), maxTicksLimit: 6, maxRotation: 0 }, grid: { display: false } },
        y: { stacked: !!c.stacked, ticks: { color: css("--muted") }, grid: { color: css("--line") } },
      },
    },
  });
});

// Period rows, or monthly averages over all history.
function rows(days) {
  if (days) return DAILY.slice(-days);
  const months = new Map();
  for (const r of DAILY) {
    const key = r[0].slice(0, 7);
    if (!months.has(key)) months.set(key, []);
    months.get(key).push(r);
  }
  return [...months.entries()].map(([month, list]) => [month, ...DATA.metrics.map((_, i) => {
    const values = list.map((r) => r[i + 1]).filter((v) => v != null);
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  })]);
}

const label = (key) => key.length === 7
  ? new Date(key + "-15").toLocaleDateString("en-GB", { month: "short", year: "2-digit" })
  : new Date(key + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });

function show(days) {
  const list = rows(days);
  CHARTS.forEach((c, i) => {
    const chart = instances[i];
    chart.data.labels = list.map((r) => label(r[0]));
    c.series.forEach(([, pick], j) => {
      chart.data.datasets[j].data = list.map((r) => { const v = pick(r); return v == null || Number.isNaN(v) ? null : v; });
    });
    chart.update();
    c.card.classList.toggle("empty", chart.data.datasets.every((d) => d.data.every((v) => v == null)));
  });
  document.querySelectorAll(".ranges button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.days === String(days))));
}
document.querySelectorAll(".ranges button").forEach((b) => b.addEventListener("click", () => show(Number(b.dataset.days))));
show(90);

const PACED = new Set([37, 52, 24]);
const pace = (w) => {
  if (!PACED.has(w.type) || !w.km || w.km < 0.3) return "";
  const s = Math.round(w.minutes * 60 / w.km);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0") + " /km";
};
document.getElementById("workouts").innerHTML =
  "<tr><th>Date</th><th>Activity</th><th>Duration</th><th>Distance</th><th>Pace</th><th>Avg HR</th><th>Route</th></tr>" +
  DATA.workouts.map((w) => "<tr><td>" + when(w.start) + "</td><td>" + w.activity + "</td><td>" + w.minutes + " min</td><td>" +
    (w.km ? num(w.km, 2) + " km" : "") + "</td><td>" + pace(w) + "</td><td>" + (w.hr ? num(w.hr) : "") + "</td><td>" +
    (w.route ? "<a href='__BASE__/gpx/" + w.uuid + "'>GPX</a>" : "") + "</td></tr>").join("");

const absolute = location.origin + "__BASE__";
const webcal = absolute.replace(/^https?:/, "webcal:");
document.getElementById("cal-workouts").href = webcal + "/workouts.ics";
document.getElementById("cal-sleep").href = webcal + "/sleep.ics";
document.getElementById("ha").textContent = [
  "rest:",
  "  - resource: " + absolute + "/latest.json",
  "    scan_interval: 1800",
  "    sensor:",
  "      - name: Last night sleep",
  "        value_template: \\"{{ value_json.sleep_minutes }}\\"",
  "        unit_of_measurement: min",
  "      - name: Resting HR",
  "        value_template: \\"{{ value_json.resting_hr }}\\"",
  "        unit_of_measurement: bpm",
  "      - name: Steps today",
  "        value_template: \\"{{ value_json.steps_today }}\\"",
].join("\\n");
</script>
</body>
</html>`;
