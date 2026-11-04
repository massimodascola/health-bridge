// Categories into which summary data is divided. Each automation picks some (for example "Health" without workouts, "Sports" without symptoms); the coach's main link shows them all. The English description is used in the assistant instructions that the app prepares.

export const CATEGORIES = [
  { id: "activity", label: "Daily activity", english: "daily activity (steps, energy, exercise, daylight)" },
  { id: "sleep", label: "Sleep", english: "sleep with stages" },
  { id: "heart", label: "Heart and recovery", english: "heart and recovery (resting heart rate, HRV, respiration, oxygen, VO2 max)" },
  { id: "workouts", label: "Workouts", english: "workouts with heart rate, pace, splits and swimming details" },
  { id: "body", label: "Body and measurements", english: "body measurements (weight, body fat, blood pressure, glucose, temperature)" },
  { id: "nutrition", label: "Nutrition and habits", english: "nutrition and habits (food, water, caffeine, alcohol, micronutrients, hygiene)" },
  { id: "supplements", label: "Supplements and medications", english: "supplements and medications taken or skipped" },
  { id: "symptoms", label: "Symptoms", english: "symptoms logged in Apple Health" },
  { id: "mood", label: "Mood and mindfulness", english: "mood and mindfulness" },
  { id: "alerts", label: "Watch alerts and ECG", english: "Apple Watch alerts and ECG" },
  { id: "mobility", label: "Walking and environment", english: "walking metrics, mobility, noise and UV" },
  { id: "calendar", label: "Calendar and plan", english: "my busy times for the next 14 days and the planned workouts" },
  { id: "history", label: "Long-term history", english: "long-term history" },
] as const;

export type Category = (typeof CATEGORIES)[number]["id"];

export const CATEGORY_IDS: Category[] = CATEGORIES.map((c) => c.id);

// Row filter: without a choice (main link, app) everything passes.
export type Show = (category: Category) => boolean;

export function shows(categories?: Iterable<string>): Show {
  if (!categories) return () => true;
  const set = new Set(categories);
  return (category) => set.has(category);
}

export function isCategory(value: unknown): value is Category {
  return typeof value === "string" && (CATEGORY_IDS as string[]).includes(value);
}

export function categoryLabels(categories: Iterable<string>): string {
  const set = new Set(categories);
  return CATEGORIES.filter((c) => set.has(c.id)).map((c) => c.label).join(", ");
}
