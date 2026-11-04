import SwiftUI

// Workout screens, provisional UI: final one comes from Claude Design.
// * TrainingHomeView: next plan session, current session, history.
// * ActiveSessionView: the current session, set by set, with "last time" highlighted.
// * SessionDetailView: a past session.

struct TrainingHomeView: View {
    @State private var store = TrainingStore.shared
    @State private var showActive = false

    var body: some View {
        NavigationStack {
            List {
                if let active = store.active {
                    Section {
                        Button {
                            showActive = true
                        } label: {
                            Label("Resume: \(active.title)", systemImage: "play.circle.fill")
                        }
                    }
                }

                Section("Next session") {
                    if let plan = store.upcoming.first {
                        PlanCard(plan: plan, store: store)
                        Button("Start this session") {
                            store.start(plan)
                            showActive = true
                        }
                        .disabled(store.active != nil)
                    } else {
                        Text("No plan. Ask the coach for the plan and import it below.")
                            .foregroundStyle(.secondary)
                    }
                }

                Section {
                    NavigationLink {
                        CalendarPlanView()
                    } label: {
                        Label("Import the coach's plan", systemImage: "square.and.arrow.down")
                    }
                    Button {
                        store.start(nil)
                        showActive = true
                    } label: {
                        Label("Free workout", systemImage: "plus.circle")
                    }
                    .disabled(store.active != nil)
                }

                let later = store.upcoming.dropFirst()
                if !later.isEmpty {
                    Section("Upcoming sessions") {
                        ForEach(Array(later)) { plan in
                            NavigationLink {
                                List { PlanCard(plan: plan, store: store) }.navigationTitle(plan.title)
                            } label: {
                                VStack(alignment: .leading) {
                                    Text(plan.title)
                                    Text(plan.start.formatted(.dateTime.weekday(.wide).day().month().hour().minute()))
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }

                if !store.finished.isEmpty {
                    Section("History") {
                        ForEach(store.finished) { session in
                            NavigationLink {
                                SessionDetailView(session: session)
                            } label: {
                                VStack(alignment: .leading) {
                                    Text(session.title)
                                    Text("\(session.start.formatted(.dateTime.weekday(.wide).day().month())) · \(session.exercises.reduce(0) { $0 + $1.sets.count }) sets")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Workout")
            .navigationDestination(isPresented: $showActive) { ActiveSessionView() }
        }
    }
}

private struct PlanCard: View {
    let plan: PlannedWorkout
    let store: TrainingStore

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(plan.title).font(.headline)
            Text("\(plan.start.formatted(.dateTime.weekday(.wide).day().month().hour().minute())) · \(plan.minutes) min")
                .font(.subheadline).foregroundStyle(.secondary)
            if let notes = plan.notes { Text(notes).font(.caption).foregroundStyle(.secondary) }
        }
        ForEach(plan.exercises) { exercise in
            VStack(alignment: .leading, spacing: 2) {
                Text(exercise.name)
                Text(exercise.target).font(.caption).foregroundStyle(.secondary)
                if let last = store.lastTimeText(exercise.name) {
                    Text("Last time \(last)").font(.caption).foregroundStyle(.orange)
                }
            }
        }
    }
}

struct ActiveSessionView: View {
    @State private var store = TrainingStore.shared
    @State private var newExercise = ""
    @State private var addingExercise = false
    @State private var confirmDiscard = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            if let session = store.active {
                if session.exercises.indices.contains(session.current) {
                    let exercise = session.exercises[session.current]
                    Section {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(exercise.name).font(.title2.weight(.semibold))
                            if let target = exercise.target {
                                Text("Plan: \(target.target)" + (target.restSeconds.map { " · rest \($0) s" } ?? ""))
                                    .foregroundStyle(.secondary)
                                if let notes = target.notes { Text(notes).font(.caption).foregroundStyle(.secondary) }
                            }
                            if let last = store.lastTimeText(exercise.name) {
                                Text("Last time \(last)").font(.callout.weight(.medium)).foregroundStyle(.orange)
                            }
                        }
                        .padding(.vertical, 4)
                    }

                    if !exercise.sets.isEmpty {
                        Section("Sets done") {
                            ForEach(Array(exercise.sets.enumerated()), id: \.element.id) { index, set in
                                LabeledContent("Set \(index + 1)", value: set.text)
                                    .swipeActions {
                                        Button("Delete", role: .destructive) { store.removeSet(exercise: session.current, set: set.id) }
                                    }
                            }
                        }
                    }

                    Section("Set \(exercise.sets.count + 1)" + (exercise.target.map { " of \($0.sets)" } ?? "")) {
                        if session.draftSeconds != nil {
                            Stepper("\(session.draftSeconds ?? 0) seconds", value: secondsBinding(session), in: 0...3600, step: 5)
                        } else {
                            Stepper("\(session.draftReps ?? 0) reps", value: repsBinding(session), in: 0...100)
                        }
                        Stepper((session.draftWeightKg ?? 0) > 0 ? Training.kg(session.draftWeightKg ?? 0) : "Bodyweight",
                                value: weightBinding(session), in: 0...500, step: 2.5)
                        Button {
                            store.logSet()
                        } label: {
                            Label("Set done", systemImage: "checkmark.circle.fill").font(.headline)
                        }
                        if let ends = session.restEnds, ends > .now {
                            LabeledContent("Rest") {
                                Text(timerInterval: Date.now...ends, countsDown: true).monospacedDigit()
                            }
                        }
                    }
                }

                Section("Exercises") {
                    ForEach(Array(session.exercises.enumerated()), id: \.element.id) { index, exercise in
                        Button {
                            store.select(index)
                        } label: {
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(exercise.name).foregroundStyle(.primary)
                                    if let target = exercise.target {
                                        Text(target.target).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                Text("\(exercise.sets.count)" + (exercise.target.map { "/\($0.sets)" } ?? ""))
                                    .foregroundStyle(.secondary)
                                if index == session.current { Image(systemName: "chevron.left") }
                            }
                        }
                    }
                    Button("Add exercise") { addingExercise = true }
                    if session.current + 1 < session.exercises.count {
                        Button("Next exercise") { store.next() }
                    }
                }

                Section {
                    Button("Finish workout") {
                        store.finish()
                        dismiss()
                    }
                    .font(.headline)
                    Button("Discard this session", role: .destructive) { confirmDiscard = true }
                } footer: {
                    Text("During the session you can log sets from the Lock Screen without unlocking your phone.")
                }
            } else {
                Text("No session in progress.").foregroundStyle(.secondary)
            }
        }
        .navigationTitle(store.active?.title ?? "Workout")
        .navigationBarTitleDisplayMode(.inline)
        .alert("New exercise", isPresented: $addingExercise) {
            TextField("Name", text: $newExercise)
            Button("Add") {
                store.addExercise(newExercise)
                newExercise = ""
            }
            Button("Cancel", role: .cancel) { newExercise = "" }
        }
        .confirmationDialog("Discard the session? Sets won't reach the coach.", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("Discard", role: .destructive) {
                store.discard()
                dismiss()
            }
        }
    }

    private func repsBinding(_ session: WorkoutSession) -> Binding<Int> {
        Binding(get: { session.draftReps ?? 0 },
                set: { store.setDraft(reps: $0, weightKg: session.draftWeightKg, seconds: nil) })
    }

    private func secondsBinding(_ session: WorkoutSession) -> Binding<Int> {
        Binding(get: { session.draftSeconds ?? 0 },
                set: { store.setDraft(reps: nil, weightKg: session.draftWeightKg, seconds: $0) })
    }

    private func weightBinding(_ session: WorkoutSession) -> Binding<Double> {
        Binding(get: { session.draftWeightKg ?? 0 },
                set: { store.setDraft(reps: session.draftReps, weightKg: $0, seconds: session.draftSeconds) })
    }
}

struct SessionDetailView: View {
    let session: WorkoutSession

    var body: some View {
        List {
            Section {
                LabeledContent("Start", value: session.start.formatted(date: .abbreviated, time: .shortened))
                if let end = session.end {
                    LabeledContent("Duration", value: "\(Int(end.timeIntervalSince(session.start) / 60)) min")
                }
            }
            ForEach(session.exercises.filter { !$0.sets.isEmpty }) { exercise in
                Section(exercise.name) {
                    ForEach(Array(exercise.sets.enumerated()), id: \.element.id) { index, set in
                        LabeledContent("Set \(index + 1)", value: set.text)
                    }
                }
            }
        }
        .navigationTitle(session.title)
    }
}
