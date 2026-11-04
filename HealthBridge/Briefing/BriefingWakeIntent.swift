import AppIntents
import Foundation

// "Update the briefing" (2026-10-25): the action to launch with a Shortcuts automation
// as soon as you wake up, for example "when I open my messaging app". It immediately sends sleep, agenda
// and Reminders, then tells the briefing that you are awake: the message goes out within 10 minutes,
// even if the sleep data does not arrive. Without this action, the app sends data only when iOS wakes
// it up in the background, sometimes more than an hour after unlocking (successful on 2026-10-25).
struct BriefingWakeIntent: AppIntent {
    static let title: LocalizedStringResource = "Update the briefing"
    static let description = IntentDescription(
        "Immediately sends sleep, agenda and Reminders to the morning briefing, and tells it that you are awake.")
    // Health data can only be read while the phone is unlocked.
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    func perform() async throws -> some IntentResult {
        await BriefingAgenda.syncIfDue(force: true)
        await SyncEngine.shared.sync()
        try await BriefingClient.post("wake", body: Data("{}".utf8))
        return .result()
    }
}

// Makes the action visible in Shortcuts with its name and icon.
struct HealthBridgeShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: BriefingWakeIntent(),
            phrases: ["Update the briefing with \(.applicationName)"],
            shortTitle: "Update the briefing",
            systemImageName: "sunrise"
        )
    }
}
