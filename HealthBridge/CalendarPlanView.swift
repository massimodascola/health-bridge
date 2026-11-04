import SwiftUI

// "Import the coach's plan": paste the PLAN ... END block, show preview with
// the exercises, then put sessions in the "Workouts" calendar and the plan in the app
// (Workout section). The new plan replaces the old one from its first day.
// PasteButton reads the clipboard without the iOS permission prompt.
struct CalendarPlanView: View {
    @State private var workouts: [PlannedWorkout] = []
    @State private var replacing = 0
    @State private var message: String?
    @State private var working = false

    var body: some View {
        List {
            Section {
                PasteButton(payloadType: String.self) { strings in
                    let parsed = PlanParser.parse(strings.joined(separator: "\n"))
                    Task { @MainActor in
                        workouts = parsed
                        replacing = CalendarBridge.plannedCount(from: parsed)
                        message = parsed.isEmpty ? "Clipboard doesn't contain a plan: copy the PLAN to END block from the coach." : nil
                    }
                }
            } footer: {
                Text("Copy the PLAN to END block from the coach, then tap Paste.")
            }

            if !workouts.isEmpty {
                ForEach(workouts) { workout in
                    Section {
                        ForEach(workout.exercises) { exercise in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(exercise.name)
                                Text(exercise.target + (exercise.restSeconds.map { " · rest \($0) s" } ?? ""))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        if workout.exercises.isEmpty, let notes = workout.notes {
                            Text(notes).font(.caption).foregroundStyle(.secondary)
                        }
                    } header: {
                        Text("\(workout.title) · \(workout.start.formatted(.dateTime.weekday(.wide).day().month().hour().minute())), \(workout.minutes) min")
                    }
                }

                Section {
                    Button(working ? "Importing..." : "Import \(workouts.count) sessions") { Task { await apply() } }
                        .disabled(working)
                } footer: {
                    if replacing > 0, let first = workouts.first {
                        Text("They replace the \(replacing) workouts already in the Workouts calendar from \(first.start.formatted(.dateTime.weekday(.wide).day().month())) onward.")
                    }
                }
            }

            if let message {
                Section { Text(message) }
            }
        }
        .navigationTitle("Coach's plan")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func apply() async {
        working = true
        defer { working = false }
        let imported = TrainingStore.shared.importPlans(workouts)
        var parts = ["\(imported.added) sessions in the Workout section"]
        do {
            if !CalendarBridge.isAuthorized {
                _ = try await CalendarBridge.requestAccess()
            }
            if CalendarBridge.isAuthorized {
                let result = try CalendarBridge.apply(workouts)
                parts.append("\(result.added) in the Workouts calendar" + (result.removed > 0 ? " (\(result.removed) old removed)" : ""))
                // The coach sees the new plan immediately on the page.
                try? await SyncEngine.shared.syncCalendar(force: true)
            } else {
                parts.append("calendar not connected: enable in Settings → Apps → HealthBridge → Calendars")
            }
        } catch {
            parts.append("calendar not updated: \(error.localizedDescription)")
        }
        message = "Done: " + parts.joined(separator: "; ") + "."
        workouts = []
        replacing = 0
    }
}
