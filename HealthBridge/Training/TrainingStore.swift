import ActivityKit
import Foundation
import Observation

// Coach plans and logged sessions, saved to training.json on the phone.
// Every change updates the Lock Screen (TrainingLive) and, after a few seconds,
// sends sessions to the server (POST /training), so the coach sees sets and weights.
@MainActor @Observable
final class TrainingStore {
    static let shared = TrainingStore()

    private(set) var plans: [PlannedWorkout] = []
    private(set) var sessions: [WorkoutSession] = []
    private(set) var activeID: UUID?

    @ObservationIgnored private let fileURL: URL
    @ObservationIgnored private var syncTask: Task<Void, Never>?

    private struct Snapshot: Codable {
        var plans: [PlannedWorkout]
        var sessions: [WorkoutSession]
        var activeID: UUID?
    }

    private init() {
        let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        fileURL = folder.appending(path: "training.json")
        if let data = try? Data(contentsOf: fileURL), let snapshot = try? Self.decoder.decode(Snapshot.self, from: data) {
            plans = snapshot.plans
            sessions = snapshot.sessions
            activeID = snapshot.activeID
        }
    }

    // The file remains readable while the phone is locked (after first unlock): the
    // Lock Screen buttons write sets there too.
    private func save() {
        let snapshot = Snapshot(plans: plans, sessions: sessions, activeID: activeID)
        guard let data = try? Self.encoder.encode(snapshot) else { return }
        try? data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    // MARK: Plans

    var upcoming: [PlannedWorkout] {
        let today = Calendar.current.startOfDay(for: Date())
        return plans.filter { $0.start >= today }.sorted { $0.start < $1.start }
    }

    // The new plan replaces those from its first day onward, like a calendar.
    @discardableResult
    func importPlans(_ new: [PlannedWorkout]) -> (removed: Int, added: Int) {
        guard let first = new.first else { return (0, 0) }
        let from = Calendar.current.startOfDay(for: first.start)
        let removed = plans.filter { $0.start >= from }.count
        plans = plans.filter { $0.start < from } + new
        save()
        return (removed, new.count)
    }

    // MARK: Current session

    var active: WorkoutSession? { sessions.first { $0.id == activeID } }
    var finished: [WorkoutSession] { sessions.filter { $0.end != nil }.sorted { $0.start > $1.start } }

    func start(_ plan: PlannedWorkout?) {
        guard active == nil else { return }
        let session = WorkoutSession(
            plannedID: plan?.id,
            title: plan?.title ?? "Free workout",
            start: Date(),
            exercises: (plan?.exercises ?? []).map { SessionExercise(name: $0.name, target: $0) }
        )
        sessions.append(session)
        activeID = session.id
        mutateActive { $0.current = 0 }
        prepareDraft()
        save()
        if let state = liveState() { TrainingLive.start(title: session.title, state: state) }
    }

    func addExercise(_ name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        mutateActive {
            $0.exercises.append(SessionExercise(name: trimmed))
            $0.current = $0.exercises.count - 1
        }
        prepareDraft()
        changed()
    }

    func select(_ index: Int) {
        mutateActive { if $0.exercises.indices.contains(index) { $0.current = index } }
        prepareDraft()
        changed()
    }

    func next() {
        mutateActive {
            if $0.current + 1 < $0.exercises.count { $0.current += 1 }
            $0.restEnds = nil
        }
        prepareDraft()
        changed()
    }

    func adjust(_ action: TrainingAction) {
        mutateActive { session in
            switch action {
            case .repsUp: session.draftReps = (session.draftReps ?? 0) + 1
            case .repsDown: session.draftReps = max(0, (session.draftReps ?? 0) - 1)
            case .weightUp: session.draftWeightKg = (session.draftWeightKg ?? 0) + 2.5
            case .weightDown: session.draftWeightKg = max(0, (session.draftWeightKg ?? 0) - 2.5)
            case .secondsUp: session.draftSeconds = (session.draftSeconds ?? 0) + 5
            case .secondsDown: session.draftSeconds = max(0, (session.draftSeconds ?? 0) - 5)
            case .setDone, .next: break
            }
        }
        changed()
    }

    func setDraft(reps: Int?, weightKg: Double?, seconds: Int?) {
        mutateActive {
            $0.draftReps = reps
            $0.draftWeightKg = weightKg
            $0.draftSeconds = seconds
        }
        changed()
    }

    // Log the set with the proposed values and start the rest timer.
    func logSet() {
        mutateActive { session in
            guard session.exercises.indices.contains(session.current) else { return }
            let weight = session.draftWeightKg.flatMap { $0 > 0 ? $0 : nil }
            let set = SetLog(reps: session.draftSeconds == nil ? session.draftReps : nil, weightKg: weight,
                             seconds: session.draftSeconds, at: Date())
            session.exercises[session.current].sets.append(set)
            let rest = session.exercises[session.current].target?.restSeconds ?? 90
            session.restEnds = Date().addingTimeInterval(TimeInterval(rest))
        }
        changed()
    }

    func removeSet(exercise: Int, set: UUID) {
        mutateActive { session in
            guard session.exercises.indices.contains(exercise) else { return }
            session.exercises[exercise].sets.removeAll { $0.id == set }
        }
        changed()
    }

    func finish() {
        guard let state = liveState() else { return }
        mutateActive {
            $0.end = Date()
            $0.restEnds = nil
        }
        activeID = nil
        save()
        var final = state
        final.finished = true
        final.restEnds = nil
        Task { await TrainingLive.end(final) }
        syncNow()
    }

    // Session started by mistake: discard without sending to the coach.
    func discard() {
        guard let id = activeID else { return }
        sessions.removeAll { $0.id == id }
        activeID = nil
        save()
        Task { await TrainingLive.end(nil) }
    }

    // MARK: History

    // Sets from the last finished session with the same exercise.
    func lastTime(_ name: String) -> (date: Date, sets: [SetLog])? {
        let key = Training.key(name)
        for session in finished {
            if let exercise = session.exercises.first(where: { Training.key($0.name) == key && !$0.sets.isEmpty }) {
                return (session.start, exercise.sets)
            }
        }
        return nil
    }

    func lastTimeText(_ name: String) -> String? {
        guard let last = lastTime(name) else { return nil }
        let day = last.date.formatted(.dateTime.day().month(.abbreviated))
        return "\(day): " + last.sets.map(\.text).joined(separator: ", ")
    }

    // MARK: Internals

    private func mutateActive(_ body: (inout WorkoutSession) -> Void) {
        guard let index = sessions.firstIndex(where: { $0.id == activeID }) else { return }
        body(&sessions[index])
    }

    // Proposed values for the next set: the last set done today, otherwise the
    // plan, otherwise the first set from last time.
    // Last time is looked up before mutating: reading history while mutating
    // the session is a double access that Swift crashes on.
    private func prepareDraft() {
        guard let current = active, current.exercises.indices.contains(current.current) else { return }
        let previous = lastTime(current.exercises[current.current].name)?.sets.first
        mutateActive { session in
            let exercise = session.exercises[session.current]
            if let done = exercise.sets.last {
                session.draftReps = done.reps
                session.draftWeightKg = done.weightKg
                session.draftSeconds = done.seconds
            } else if let target = exercise.target {
                session.draftReps = target.reps
                session.draftWeightKg = target.weightKg ?? previous?.weightKg
                session.draftSeconds = target.seconds
            } else {
                session.draftReps = previous?.reps ?? (previous?.seconds == nil ? 10 : nil)
                session.draftWeightKg = previous?.weightKg
                session.draftSeconds = previous?.seconds
            }
        }
    }

    func liveState() -> TrainingAttributes.ContentState? {
        guard let session = active else { return nil }
        guard session.exercises.indices.contains(session.current) else {
            return .init(exercise: "Add an exercise", setNumber: 0, setCount: 0, reps: nil, weightKg: nil,
                         seconds: nil, lastTime: nil, nextExercise: nil, restEnds: nil, finished: false)
        }
        let exercise = session.exercises[session.current]
        let next = session.exercises.indices.contains(session.current + 1) ? session.exercises[session.current + 1].name : nil
        return .init(
            exercise: exercise.name,
            setNumber: exercise.sets.count + 1,
            setCount: exercise.target?.sets ?? 0,
            reps: session.draftReps,
            weightKg: session.draftWeightKg,
            seconds: session.draftSeconds,
            lastTime: lastTimeText(exercise.name),
            nextExercise: next,
            restEnds: session.restEnds,
            finished: false
        )
    }

    private func changed() {
        save()
        if let state = liveState() { Task { await TrainingLive.update(state) } }
        scheduleSync()
    }

    // After 5 seconds with no further changes, send sessions to the server.
    private func scheduleSync() {
        syncTask?.cancel()
        syncTask = Task {
            try? await Task.sleep(for: .seconds(5))
            guard !Task.isCancelled else { return }
            await TrainingSync.push(sessions)
        }
    }

    func syncNow() {
        syncTask?.cancel()
        let all = sessions
        Task { await TrainingSync.push(all) }
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}

// Lock Screen and Dynamic Island.
enum TrainingLive {
    static func start(title: String, state: TrainingAttributes.ContentState) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        Task {
            for activity in Activity<TrainingAttributes>.activities {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
            _ = try? Activity.request(attributes: TrainingAttributes(title: title), content: .init(state: state, staleDate: nil))
        }
    }

    static func update(_ state: TrainingAttributes.ContentState) async {
        for activity in Activity<TrainingAttributes>.activities {
            await activity.update(.init(state: state, staleDate: nil))
        }
    }

    static func end(_ state: TrainingAttributes.ContentState?) async {
        for activity in Activity<TrainingAttributes>.activities {
            await activity.end(state.map { .init(state: $0, staleDate: nil) }, dismissalPolicy: .after(.now.addingTimeInterval(600)))
        }
    }

    // If the app was closed during a session, the Lock Screen resumes on reopen.
    @MainActor
    static func restoreIfNeeded() {
        let store = TrainingStore.shared
        guard let session = store.active, Activity<TrainingAttributes>.activities.isEmpty,
              let state = store.liveState() else { return }
        start(title: session.title, state: state)
    }
}

// Sessions to server: the latest 60, finished or in progress, without draft values.
enum TrainingSync {
    private struct Payload: Encodable {
        struct Session: Encodable {
            let id: String
            let title: String
            let start: Date
            let end: Date?
            let exercises: [Exercise]
        }
        struct Exercise: Encodable {
            let name: String
            let order: Int
            let target: String?
            let sets: [Set]
        }
        struct Set: Encodable {
            let reps: Int?
            let weightKg: Double?
            let seconds: Int?
            let at: Date
        }
        let sessions: [Session]
    }

    static func push(_ sessions: [WorkoutSession]) async {
        // Like SyncEngine.post: no real server sends from the simulator.
        #if targetEnvironment(simulator)
        return
        #endif
        let recent = sessions.sorted { $0.start > $1.start }.prefix(60)
        let payload = Payload(sessions: recent.map { session in
            Payload.Session(id: session.id.uuidString, title: session.title, start: session.start, end: session.end,
                            exercises: session.exercises.enumerated().map { order, exercise in
                                Payload.Exercise(name: exercise.name, order: order, target: exercise.target?.target,
                                                 sets: exercise.sets.map { .init(reps: $0.reps, weightKg: $0.weightKg, seconds: $0.seconds, at: $0.at) })
                            })
        })
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let body = try? encoder.encode(payload) else { return }
        var request = URLRequest(url: Secrets.serverURL.appending(path: "training"))
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("Bearer \(Secrets.ingestToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        _ = try? await URLSession.shared.data(for: request)
    }
}
