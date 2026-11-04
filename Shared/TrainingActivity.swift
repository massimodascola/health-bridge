import ActivityKit
import AppIntents
import Foundation

// Workout on the Lock Screen (Live Activity): suggested exercise, sets, reps and
// weight, rest, last time. The buttons work without unlocking the phone.
// Compiled both in the app and the widget: the widget draws, the app executes the commands (TrainingCommands).

struct TrainingAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var exercise: String
        var setNumber: Int
        var setCount: Int
        var reps: Int?
        var weightKg: Double?
        var seconds: Int?
        var lastTime: String?
        var nextExercise: String?
        var restEnds: Date?
        var finished: Bool
    }

    var title: String
}

// What a button can request. LiveActivityIntent runs in the app's process even
// when the app is closed: there TrainingCommands is real, in the widget it is an empty placeholder.
enum TrainingAction: String, AppEnum {
    case setDone, next, repsUp, repsDown, weightUp, weightDown, secondsUp, secondsDown

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Workout command"
    static let caseDisplayRepresentations: [TrainingAction: DisplayRepresentation] = [
        .setDone: "Set done",
        .next: "Next exercise",
        .repsUp: "One rep more",
        .repsDown: "One rep less",
        .weightUp: "More weight",
        .weightDown: "Less weight",
        .secondsUp: "More time",
        .secondsDown: "Less time",
    ]
}

struct TrainingActionIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Workout command"
    static let isDiscoverable = false

    @Parameter(title: "Command")
    var action: TrainingAction

    init() {}

    init(_ action: TrainingAction) {
        self.action = action
    }

    func perform() async throws -> some IntentResult {
        await TrainingCommands.run(action)
        return .result()
    }
}
