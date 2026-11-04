import CoreLocation
import SwiftUI

// "Morning briefing" on the main screen: what the app sends to your briefing
// service and when it last started (see BriefingLocation and BriefingAgenda).
struct BriefingSection: View {
    @ObservedObject private var location = BriefingLocation.shared
    @AppStorage(BriefingLocation.lastSentKey) private var lastSentAt: Double = 0
    @AppStorage(BriefingLocation.lastPlaceKey) private var lastPlace = ""
    @AppStorage(BriefingLocation.lastErrorKey) private var lastError = ""
    @AppStorage(BriefingAgenda.lastSentKey) private var agendaSentAt: Double = 0
    @AppStorage(BriefingAgenda.summaryKey) private var agendaSummary = ""
    @AppStorage(BriefingAgenda.lastErrorKey) private var agendaError = ""
    @State private var remindersAuthorized = BriefingAgenda.remindersAuthorized
    @State private var remindersError: String?

    var body: some View {
        Section {
            switch location.authorization {
            case .authorizedAlways:
                LabeledContent("Location sent", value: sent)
            case .authorizedWhenInUse:
                LabeledContent("Location sent", value: sent)
                Button("Choose \"Always\" in Settings") { openSettings() }
            case .denied, .restricted:
                Button("Allow location in Settings") { openSettings() }
            default:
                Button("Connect location") { location.requestAccess() }
            }
            if !lastError.isEmpty {
                Text(lastError).font(.footnote).foregroundStyle(.orange)
            }

            if !CalendarBridge.isAuthorized {
                Text("For the agenda, connect Calendar in the Calendar section above.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if !remindersAuthorized {
                Button("Connect Reminders") { Task { await connectReminders() } }
            }
            if agendaSentAt > 0 {
                LabeledContent("Agenda and Reminders sent", value: Self.relative(agendaSentAt))
                if !agendaSummary.isEmpty {
                    Text(agendaSummary).font(.footnote).foregroundStyle(.secondary)
                }
            }
            if let message = remindersError ?? (agendaError.isEmpty ? nil : agendaError) {
                Text(message).font(.footnote).foregroundStyle(.orange)
            }
        } header: {
            Text("Morning briefing")
        } footer: {
            Text("Your morning briefing service (configured in scripts/make-secrets.sh) can tell you every morning about sleep, water, weather, events, birthdays and to-dos. The app sends it the location (only the latest, rounded to about one kilometer), events for the next 7 days with titles, birthdays and the \(BriefingAgenda.wantedLists.joined(separator: ", ")) lists from Reminders (only names for other lists). All of this goes to the briefing, not the coach. With location set to \"Always\", the weather follows your movements even when the app is closed.")
        }
    }

    private var sent: String {
        guard lastSentAt > 0 else { return "not yet" }
        let when = Self.relative(lastSentAt)
        return lastPlace.isEmpty ? when : "\(lastPlace), \(when)"
    }

    private func connectReminders() async {
        do {
            remindersAuthorized = try await BriefingAgenda.requestRemindersAccess()
            remindersError = remindersAuthorized ? nil : "Reminders not connected: allow them in Settings."
            if remindersAuthorized { await BriefingAgenda.syncIfDue(force: true) }
        } catch {
            remindersError = "Reminders not connected: \(error.localizedDescription)"
        }
    }

    private func openSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
    }

    private static func relative(_ timestamp: Double) -> String {
        Date(timeIntervalSince1970: timestamp).formatted(.relative(presentation: .named))
    }
}
