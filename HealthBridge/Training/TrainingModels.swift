import Foundation

// Workout (2026-10-14): coach plans, sessions logged set by set.
// Data lives on the phone (training.json, see TrainingStore) and goes to the server
// (POST /training) so the coach can see sets, reps, and weights.

// An exercise as written by the coach: "> Squat | 4x8 | 60 kg | 120 s | notes".
struct PlannedExercise: Codable, Hashable, Identifiable {
    var id = UUID()
    var name: String
    var sets: Int
    // Reference reps (the lower number of "8-10"); nil for timed or "max" exercises.
    var reps: Int?
    // As written by the coach: "8-10", "max", "45 s".
    var repsText: String
    var seconds: Int?
    var weightKg: Double?
    var restSeconds: Int?
    var notes: String?

    // "4 × 8 · 60 kg" for screens.
    var target: String {
        var text = "\(sets) × \(repsText)"
        if let weightKg { text += " · \(Training.kg(weightKg))" }
        return text
    }
}

// A workout in the plan: "2026-10-15 18:30 | 60 | Lower body strength | notes".
struct PlannedWorkout: Codable, Hashable, Identifiable {
    var id = UUID()
    var start: Date
    var minutes: Int
    var title: String
    var notes: String?
    var exercises: [PlannedExercise]
}

struct SetLog: Codable, Hashable, Identifiable {
    var id = UUID()
    var reps: Int?
    var weightKg: Double?
    var seconds: Int?
    var at: Date

    // "60 × 8", "8 reps", "45 s".
    var text: String {
        if let seconds { return weightKg.map { "\(Training.kg($0)) × \(seconds) s" } ?? "\(seconds) s" }
        if let weightKg, let reps { return "\(Training.number(weightKg)) × \(reps)" }
        if let reps { return "\(reps) reps" }
        return "done"
    }
}

struct SessionExercise: Codable, Hashable, Identifiable {
    var id = UUID()
    var name: String
    var target: PlannedExercise?
    var sets: [SetLog] = []
}

struct WorkoutSession: Codable, Hashable, Identifiable {
    var id = UUID()
    var plannedID: UUID?
    var title: String
    var start: Date
    var end: Date?
    var exercises: [SessionExercise]
    // Current exercise and suggested values for the next set (adjusted with + and -).
    var current = 0
    var draftReps: Int?
    var draftWeightKg: Double?
    var draftSeconds: Int?
    var restEnds: Date?
}

enum Training {
    static func kg(_ value: Double) -> String { "\(number(value)) kg" }

    static func number(_ value: Double) -> String {
        value.formatted(.number.precision(.fractionLength(0...2)))
    }

    // Same exercise even if written with different capitalization or spacing.
    static func key(_ name: String) -> String {
        name.lowercased().split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
}

// Parses the coach block. One line per session, exercise lines below starting with ">":
//   PLAN
//   2026-10-15 18:30 | 60 | Lower body strength | notes
//   > Squat | 4x8 | 60 kg | 120 s
//   > Plank | 3x45 s | bodyweight | 60 s
//   END
// Unrelated lines (surrounding text, PLAN, END) are ignored.
enum PlanParser {
    static func parse(_ text: String) -> [PlannedWorkout] {
        let dateFormatter = DateFormatter()
        dateFormatter.locale = Locale(identifier: "en_US_POSIX")
        dateFormatter.timeZone = .current
        dateFormatter.dateFormat = "yyyy-MM-dd H:mm"
        var workouts: [PlannedWorkout] = []
        for raw in text.components(separatedBy: .newlines) {
            let trimmed = raw.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix(">") {
                guard !workouts.isEmpty, let exercise = exercise(String(trimmed.dropFirst())) else { continue }
                workouts[workouts.count - 1].exercises.append(exercise)
                continue
            }
            let line = trimmed.trimmingCharacters(in: CharacterSet(charactersIn: " \t-*•`"))
            let parts = fields(line)
            guard parts.count >= 3,
                  let start = dateFormatter.date(from: parts[0].replacingOccurrences(of: ".", with: ":")),
                  let minutes = Int(parts[1]), (5...600).contains(minutes),
                  !parts[2].isEmpty else { continue }
            let notes = parts.count > 3 ? parts[3...].joined(separator: " | ") : ""
            workouts.append(PlannedWorkout(start: start, minutes: minutes, title: parts[2],
                                           notes: notes.isEmpty ? nil : notes, exercises: []))
        }
        return workouts.sorted { $0.start < $1.start }
    }

    private static func fields(_ line: String) -> [String] {
        line.split(separator: "|", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
    }

    // "Squat | 4x8 | 60 kg | 120 s | notes"
    private static func exercise(_ line: String) -> PlannedExercise? {
        let parts = fields(line)
        guard parts.count >= 2, !parts[0].isEmpty else { return nil }
        let scheme = parts[1].lowercased().replacingOccurrences(of: "×", with: "x").replacingOccurrences(of: " ", with: "")
        let pieces = scheme.split(separator: "x", maxSplits: 1).map(String.init)
        guard pieces.count == 2, let sets = Int(pieces[0]), (1...20).contains(sets) else { return nil }
        var repsText = pieces[1]
        var reps: Int?
        var seconds: Int?
        if let value = duration(repsText) {
            seconds = value
            repsText = "\(value) s"
        } else {
            reps = Int(repsText.split(separator: "-").first ?? "")
        }
        return PlannedExercise(
            name: parts[0],
            sets: sets,
            reps: reps,
            repsText: repsText,
            seconds: seconds,
            weightKg: parts.count > 2 ? weight(parts[2]) : nil,
            restSeconds: parts.count > 3 ? duration(parts[3].lowercased().replacingOccurrences(of: " ", with: "")) : nil,
            notes: parts.count > 4 ? parts[4...].joined(separator: " | ").nilIfEmpty : nil
        )
    }

    // "60 kg", "62,5kg" -> 60, 62.5; "bodyweight" or empty -> nil.
    private static func weight(_ text: String) -> Double? {
        let digits = text.lowercased().replacingOccurrences(of: "kg", with: "").replacingOccurrences(of: ",", with: ".")
            .trimmingCharacters(in: .whitespaces)
        return Double(digits)
    }

    // "45s", "90 s", "45 sec", "2min", "1:30" -> seconds.
    private static func duration(_ raw: String) -> Int? {
        let text = raw.replacingOccurrences(of: "seconds", with: "s").replacingOccurrences(of: "sec", with: "s")
        if text.hasSuffix("min"), let value = Double(text.dropLast(3).replacingOccurrences(of: ",", with: ".")) {
            return Int(value * 60)
        }
        if text.hasSuffix("s"), let value = Int(text.dropLast()) {
            return value
        }
        let clock = text.split(separator: ":")
        if clock.count == 2, let minutes = Int(clock[0]), let secs = Int(clock[1]) { return minutes * 60 + secs }
        return nil
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
