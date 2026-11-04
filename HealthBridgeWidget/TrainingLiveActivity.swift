import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

// Workout on the Lock Screen and in the Dynamic Island. Buttons: reps (or
// seconds) and weight plus/minus, "Set done", "Next". Placeholder graphics: final
// design comes from Claude Design.
struct TrainingLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TrainingAttributes.self) { context in
            TrainingLockScreen(title: context.attributes.title, state: context.state)
                .padding(14)
                .activityBackgroundTint(Color.black.opacity(0.75))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            let state = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Text(state.exercise).font(.headline).lineLimit(1)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    RestTimer(state: state).font(.headline)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    TrainingControls(state: state)
                }
            } compactLeading: {
                Image(systemName: "dumbbell.fill")
            } compactTrailing: {
                if let ends = state.restEnds, ends > .now {
                    Text(timerInterval: Date.now...ends, countsDown: true).monospacedDigit().frame(width: 44)
                } else {
                    Text(state.setCount > 0 ? "\(min(state.setNumber, state.setCount))/\(state.setCount)" : "\(state.setNumber)")
                }
            } minimal: {
                Image(systemName: "dumbbell.fill")
            }
        }
    }
}

private struct TrainingLockScreen: View {
    let title: String
    let state: TrainingAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(state.finished ? "\(title): finished" : state.exercise).font(.headline).lineLimit(1)
                    Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                RestTimer(state: state).font(.title3.weight(.semibold))
            }
            if !state.finished {
                TrainingControls(state: state)
            }
        }
        .foregroundStyle(.white)
    }

    private var subtitle: String {
        if state.finished { return "Workout saved" }
        var parts = [state.setCount > 0 ? "Set \(state.setNumber) of \(state.setCount)" : "Set \(state.setNumber)"]
        if let last = state.lastTime { parts.append("last time \(last)") }
        return parts.joined(separator: " · ")
    }
}

private struct RestTimer: View {
    let state: TrainingAttributes.ContentState

    var body: some View {
        if let ends = state.restEnds, ends > .now {
            Text(timerInterval: Date.now...ends, countsDown: true)
                .monospacedDigit()
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: 64)
        }
    }
}

private struct TrainingControls: View {
    let state: TrainingAttributes.ContentState

    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 6) {
                if let seconds = state.seconds {
                    stepper(value: "\(seconds) s", down: .secondsDown, up: .secondsUp)
                } else {
                    stepper(value: "\(state.reps ?? 0) reps", down: .repsDown, up: .repsUp)
                }
                stepper(value: state.weightKg.map { $0 > 0 ? kg($0) : "bodyweight" } ?? "bodyweight", down: .weightDown, up: .weightUp)
            }
            HStack(spacing: 6) {
                Button(intent: TrainingActionIntent(.setDone)) {
                    Label("Set done", systemImage: "checkmark").frame(maxWidth: .infinity)
                }
                .tint(.green)
                Button(intent: TrainingActionIntent(.next)) {
                    Label("Next", systemImage: "forward.fill").frame(maxWidth: .infinity)
                }
                .tint(.gray)
            }
            .font(.subheadline.weight(.semibold))
        }
    }

    private func kg(_ value: Double) -> String {
        value.formatted(.number.precision(.fractionLength(0...2))) + " kg"
    }

    private func stepper(value: String, down: TrainingAction, up: TrainingAction) -> some View {
        HStack(spacing: 4) {
            Button(intent: TrainingActionIntent(down)) { Image(systemName: "minus") }
            Text(value).font(.subheadline.weight(.semibold)).monospacedDigit().frame(maxWidth: .infinity)
            Button(intent: TrainingActionIntent(up)) { Image(systemName: "plus") }
        }
        .tint(.white.opacity(0.25))
        .frame(maxWidth: .infinity)
    }
}
