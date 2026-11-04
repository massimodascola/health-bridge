// Workouts logged in the app set by set (POST /training): the coach sees
// real reps and loads, which Apple Health doesn't record, and the last load of
// each exercise to progress weights.

import { formatDay, localDateTime } from "./time";

// The body is passed whole to D1, which splits it with JSON functions (like /ingest).
const REPLACE = [
  "DELETE FROM training_sets WHERE session_id IN (SELECT json_extract(value, '$.id') FROM json_each(?1, '$.sessions'))",
  `INSERT OR REPLACE INTO training_sessions (id, title, started_at, ended_at)
   SELECT json_extract(value, '$.id'), substr(json_extract(value, '$.title'), 1, 200),
          json_extract(value, '$.start'), json_extract(value, '$.end')
   FROM json_each(?1, '$.sessions')`,
  `INSERT INTO training_sets (session_id, exercise, exercise_order, target, set_index, reps, weight_kg, seconds, logged_at)
   SELECT json_extract(s.value, '$.id'), substr(json_extract(e.value, '$.name'), 1, 200), json_extract(e.value, '$.order'),
          json_extract(e.value, '$.target'), x.key, json_extract(x.value, '$.reps'), json_extract(x.value, '$.weightKg'),
          json_extract(x.value, '$.seconds'), json_extract(x.value, '$.at')
   FROM json_each(?1, '$.sessions') s, json_each(s.value, '$.exercises') e, json_each(e.value, '$.sets') x`,
];

export async function receiveTraining(db: D1Database, body: string): Promise<Response> {
  const results = await db.batch(REPLACE.map((sql) => db.prepare(sql).bind(body)));
  return Response.json({ sessions: results[1].meta.changes, sets: results[2].meta.changes });
}

export interface TrainingRow {
  id: string;
  title: string;
  started_at: string;
  ended_at: string | null;
  exercise: string;
  exercise_order: number;
  target: string | null;
  set_index: number;
  reps: number | null;
  weight_kg: number | null;
  seconds: number | null;
}

export interface LastLoad {
  exercise: string;
  day: string;
  sets: string;
  best: string | null;
}

export interface TrainingLog {
  sessions: { title: string; start: string; end: string | null; exercises: { name: string; target: string | null; sets: string[] }[] }[];
  lastLoads: LastLoad[];
}

export function trainingQueries(db: D1Database, since: string): D1PreparedStatement[] {
  return [
    db.prepare(`SELECT s.id, s.title, s.started_at, s.ended_at, t.exercise, t.exercise_order, t.target, t.set_index,
        t.reps, t.weight_kg, t.seconds
      FROM training_sessions s JOIN training_sets t ON t.session_id = s.id
      WHERE s.started_at >= ?1 ORDER BY s.started_at, t.exercise_order, t.set_index`).bind(since),
    // For each exercise: sets from the last session and the all-time highest load.
    db.prepare(`WITH last AS (
        SELECT exercise, max(logged_at) AS at FROM training_sets GROUP BY lower(exercise)
      )
      SELECT t.exercise, t.session_id, t.set_index, t.reps, t.weight_kg, t.seconds, t.logged_at,
        (SELECT max(weight_kg) FROM training_sets b WHERE lower(b.exercise) = lower(t.exercise)) AS best_kg
      FROM training_sets t JOIN last l ON lower(l.exercise) = lower(t.exercise)
      WHERE t.session_id = (SELECT session_id FROM training_sets WHERE lower(exercise) = lower(t.exercise) AND logged_at = l.at LIMIT 1)
      ORDER BY t.exercise, t.set_index`),
  ];
}

const decimal = (value: number) => String(value);

export function setText(reps: number | null, weightKg: number | null, seconds: number | null): string {
  if (seconds) return weightKg ? `${decimal(weightKg)} kg × ${seconds} s` : `${seconds} s`;
  if (weightKg && reps !== null) return `${decimal(weightKg)}×${reps}`;
  if (reps !== null) return `${reps} reps`;
  return "done";
}

export function computeTraining(rows: TrainingRow[], lastRows: (TrainingRow & { logged_at: string; best_kg: number | null })[]): TrainingLog {
  const sessions: TrainingLog["sessions"] = [];
  let currentId: string | null = null;
  for (const r of rows) {
    if (r.id !== currentId) {
      sessions.push({ title: r.title, start: r.started_at, end: r.ended_at, exercises: [] });
      currentId = r.id;
    }
    const session = sessions[sessions.length - 1];
    let exercise = session.exercises[session.exercises.length - 1];
    if (!exercise || exercise.name !== r.exercise) {
      exercise = { name: r.exercise, target: r.target, sets: [] };
      session.exercises.push(exercise);
    }
    exercise.sets.push(setText(r.reps, r.weight_kg, r.seconds));
  }

  const byExercise = new Map<string, LastLoad & { list: string[] }>();
  for (const r of lastRows) {
    const key = r.exercise.toLowerCase();
    const entry = byExercise.get(key) ?? {
      exercise: r.exercise,
      day: localDateTime(r.logged_at).slice(0, 10),
      sets: "",
      best: r.best_kg ? `${decimal(r.best_kg)} kg` : null,
      list: [],
    };
    entry.list.push(setText(r.reps, r.weight_kg, r.seconds));
    byExercise.set(key, entry);
  }
  const lastLoads = [...byExercise.values()].map(({ list, ...rest }) => ({ ...rest, sets: list.join(", ") }));
  return { sessions, lastLoads };
}

export function renderTraining(t: TrainingLog): string[] {
  const lines: string[] = [];
  if (t.sessions.length) {
    lines.push("", "Workouts logged in the app, set by set (weight × reps):");
    for (const s of t.sessions) {
      const when = `${formatDay(localDateTime(s.start).slice(0, 10))} ${localDateTime(s.start).slice(11)}`;
      const exercises = s.exercises.map((e) => `${e.name} ${e.sets.join(", ")}${e.target ? ` (plan ${e.target})` : ""}`);
      lines.push(`* ${when} ${s.title}${s.end ? "" : " (in progress)"}: ${exercises.join("; ")}`);
    }
  }
  if (t.lastLoads.length) {
    lines.push("", "Last time for each exercise (sets from the last session; all-time max weight):");
    for (const l of t.lastLoads) {
      lines.push(`* ${l.exercise}: ${formatDay(l.day)}, ${l.sets}${l.best ? `; max ${l.best}` : ""}`);
    }
  }
  return lines;
}
