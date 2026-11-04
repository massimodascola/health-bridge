// English names and units for less frequent data types: occasionally measured values, micronutrients, and symptoms. Only those with data appear in the summary.

import type { Category } from "./categories";

const Q = "HKQuantityTypeIdentifier";
const C = "HKCategoryTypeIdentifier";

export interface Measure {
  type: string;
  category: Category;
  label: string;
  unit: string;
  // Factor from stored unit to displayed unit (m/s -> km/h, m -> cm).
  factor: number;
  decimals: number;
  // "avg": period average. "sum": period total. "last": last value, even if older than the period (FTP, spirometry, lean body mass are measured rarely).
  show: "avg" | "sum" | "last";
}

const m = (name: string, category: Category, label: string, unit: string, show: Measure["show"], decimals = 0, factor = 1): Measure =>
  ({ type: `${Q}${name}`, category, label, unit, factor, decimals, show });

export const MEASURES: Measure[] = [
  m("HeartRateVariabilityRMSSD", "heart", "HRV (RMSSD)", "ms", "avg"),
  m("WalkingHeartRateAverage", "heart", "Avg walking heart rate", "bpm", "avg"),
  m("AppleSleepingWristTemperature", "sleep", "Wrist temperature during sleep", "°C", "avg", 2),
  m("BodyTemperature", "body", "Body temperature", "°C", "avg", 1),
  m("BasalBodyTemperature", "body", "Basal body temperature", "°C", "avg", 2),
  m("BloodGlucose", "body", "Blood glucose", "mg/dL", "avg"),
  m("WalkingSpeed", "mobility", "Walking speed", "km/h", "avg", 1, 3.6),
  m("WalkingStepLength", "mobility", "Step length", "cm", "avg", 0, 100),
  m("WalkingAsymmetryPercentage", "mobility", "Walking asymmetry", "%", "avg", 1),
  m("WalkingDoubleSupportPercentage", "mobility", "Double support while walking", "%", "avg", 1),
  m("AppleWalkingSteadiness", "mobility", "Walking steadiness", "%", "last"),
  m("SixMinuteWalkTestDistance", "mobility", "Estimated distance in 6-minute walk test", "m", "last"),
  m("StairAscentSpeed", "mobility", "Stair ascent speed", "m/s", "avg", 2),
  m("StairDescentSpeed", "mobility", "Stair descent speed", "m/s", "avg", 2),
  m("NumberOfTimesFallen", "mobility", "Detected falls", "", "sum"),
  m("AtrialFibrillationBurden", "alerts", "Atrial fibrillation burden", "%", "last", 1),
  m("EnvironmentalAudioExposure", "mobility", "Average environmental noise", "dBA", "avg"),
  m("HeadphoneAudioExposure", "mobility", "Average headphone volume", "dBA", "avg"),
  m("UVExposure", "mobility", "Average UV index", "", "avg", 1),
  m("LeanBodyMass", "body", "Lean body mass", "kg", "last", 1),
  m("BodyMassIndex", "body", "Body mass index", "", "last", 1),
  m("WaistCircumference", "body", "Waist circumference", "cm", "last", 0, 100),
  m("CyclingFunctionalThresholdPower", "workouts", "Cycling FTP", "W", "last"),
  m("ForcedExpiratoryVolume1", "body", "FEV1", "L", "last", 2),
  m("ForcedVitalCapacity", "body", "Forced vital capacity", "L", "last", 2),
  m("PeakExpiratoryFlowRate", "body", "Peak expiratory flow", "L/min", "last"),
  m("InhalerUsage", "body", "Inhaler", "puffs", "sum"),
  m("PeripheralPerfusionIndex", "heart", "Perfusion index", "%", "avg", 1),
  m("ElectrodermalActivity", "body", "Electrodermal activity", "µS", "avg", 2),
  m("BloodAlcoholContent", "nutrition", "Blood alcohol content", "%", "last", 3),
];

export interface Nutrient {
  type: string;
  label: string;
  unit: string;
}

const n = (name: string, label: string, unit: string): Nutrient => ({ type: `${Q}Dietary${name}`, label, unit });

// Units as saved by the app: grams for sugars, fiber, and fats; mg or µg for the rest.
export const NUTRIENTS: Nutrient[] = [
  n("Sugar", "sugars", "g"),
  n("Fiber", "fiber", "g"),
  n("FatSaturated", "saturated fat", "g"),
  n("FatMonounsaturated", "monounsaturated fat", "g"),
  n("FatPolyunsaturated", "polyunsaturated fat", "g"),
  n("Cholesterol", "cholesterol", "mg"),
  n("Sodium", "sodium", "mg"),
  n("Potassium", "potassium", "mg"),
  n("Calcium", "calcium", "mg"),
  n("Iron", "iron", "mg"),
  n("Magnesium", "magnesium", "mg"),
  n("Phosphorus", "phosphorus", "mg"),
  n("Zinc", "zinc", "mg"),
  n("Copper", "copper", "mg"),
  n("Manganese", "manganese", "mg"),
  n("Selenium", "selenium", "µg"),
  n("Iodine", "iodine", "µg"),
  n("Chromium", "chromium", "µg"),
  n("Molybdenum", "molybdenum", "µg"),
  n("Chloride", "chloride", "mg"),
  n("Biotin", "biotin", "µg"),
  n("Folate", "folate", "µg"),
  n("Niacin", "niacin (B3)", "mg"),
  n("PantothenicAcid", "pantothenic acid (B5)", "mg"),
  n("Riboflavin", "riboflavin (B2)", "mg"),
  n("Thiamin", "thiamin (B1)", "mg"),
  n("VitaminA", "vitamin A", "µg"),
  n("VitaminB6", "vitamin B6", "mg"),
  n("VitaminB12", "vitamin B12", "µg"),
  n("VitaminC", "vitamin C", "mg"),
  n("VitaminD", "vitamin D", "µg"),
  n("VitaminE", "vitamin E", "mg"),
  n("VitaminK", "vitamin K", "µg"),
];

// Symptoms manually logged in Health. The value is severity (HKCategoryValueSeverity: 1 absent, 2 mild, 3 moderate, 4 severe, 0 unspecified), except three exceptions below.
export const SYMPTOMS: Record<string, string> = {
  AbdominalCramps: "abdominal cramps",
  Acne: "acne",
  AppetiteChanges: "appetite changes",
  BladderIncontinence: "bladder incontinence",
  Bloating: "bloating",
  BreastPain: "breast pain",
  ChestTightnessOrPain: "chest tightness or pain",
  Chills: "chills",
  Constipation: "constipation",
  Coughing: "coughing",
  Diarrhea: "diarrhea",
  Dizziness: "dizziness",
  DrySkin: "dry skin",
  Fainting: "fainting",
  Fatigue: "fatigue",
  Fever: "fever",
  GeneralizedBodyAche: "generalized body ache",
  HairLoss: "hair loss",
  Headache: "headache",
  Heartburn: "heartburn",
  HotFlashes: "hot flashes",
  LossOfSmell: "loss of smell",
  LossOfTaste: "loss of taste",
  LowerBackPain: "lower back pain",
  MemoryLapse: "memory lapses",
  MoodChanges: "mood changes",
  Nausea: "nausea",
  NightSweats: "night sweats",
  PelvicPain: "pelvic pain",
  RapidPoundingOrFlutteringHeartbeat: "rapid, pounding, or fluttering heartbeat",
  RunnyNose: "runny nose",
  ShortnessOfBreath: "shortness of breath",
  SinusCongestion: "sinus congestion",
  SkippedHeartbeat: "skipped heartbeat",
  SleepChanges: "sleep changes",
  SoreThroat: "sore throat",
  Vomiting: "vomiting",
  Wheezing: "wheezing",
};

export const SYMPTOM_TYPES = Object.keys(SYMPTOMS).map((name) => `${C}${name}`);

export function symptomName(type: string): string {
  return SYMPTOMS[type.replace(C, "")] ?? type.replace(C, "");
}

const SEVERITY = ["unspecified", "absent", "mild", "moderate", "severe"];

// "mild", "moderate"... or null if the symptom is logged as absent.
export function symptomLevel(type: string, value: number | null): string | null {
  const name = type.replace(C, "");
  // Mood changes and sleep changes: HKCategoryValuePresence, 0 present and 1 absent.
  if (name === "MoodChanges" || name === "SleepChanges") return value === 1 ? null : "present";
  // Appetite: HKCategoryValueAppetiteChanges, 1 no change, 2 less, 3 more.
  if (name === "AppetiteChanges") return value === 2 ? "decreased appetite" : value === 3 ? "increased appetite" : null;
  if (value === 1) return null;
  return SEVERITY[value ?? 0] ?? "unspecified";
}
