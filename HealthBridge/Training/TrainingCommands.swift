// Commands for lock screen button actions (TrainingActionIntent, in Shared/).
// iOS runs them in the app process, even when the app is closed and the phone is locked.
enum TrainingCommands {
    static func run(_ action: TrainingAction) async {
        let state = await MainActor.run { () -> TrainingAttributes.ContentState? in
            let store = TrainingStore.shared
            switch action {
            case .setDone: store.logSet()
            case .next: store.next()
            default: store.adjust(action)
            }
            return store.liveState()
        }
        // Waits for the update: the lock screen changes before the button returns.
        if let state { await TrainingLive.update(state) }
    }
}
