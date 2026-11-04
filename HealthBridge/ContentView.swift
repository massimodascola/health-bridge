import SwiftUI

struct ContentView: View {
    @AppStorage(SyncKeys.lastSuccessAt) private var lastSuccessAt: Double = 0
    @AppStorage(SyncKeys.lastError) private var lastError = ""
    @AppStorage(SyncKeys.totalSent) private var totalSent = 0
    @AppStorage(SyncKeys.needsAuthorization) private var needsAuthorization = false
    @State private var lastCoachRead: Date?
    @State private var isSyncing = false
    @State private var authorizationError: String?
    @State private var calendarAuthorized = CalendarBridge.isAuthorized
    @AppStorage(SyncKeys.lastCalendarAt) private var lastCalendarAt: Double = 0

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: status.icon)
                            .font(.title)
                            .foregroundStyle(status.color)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(status.title).font(.headline)
                            Text(status.detail).font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)

                    LabeledContent("Last read by the coach",
                                   value: lastCoachRead?.formatted(.relative(presentation: .named)) ?? "no read yet")

                    NavigationLink {
                        SummaryView()
                    } label: {
                        Label("What the coach sees", systemImage: "doc.text.magnifyingglass")
                    }

                    Link(destination: Secrets.dashboardURL) {
                        Label("Charts & exports", systemImage: "chart.xyaxis.line")
                    }

                    NavigationLink {
                        AutomationsView()
                    } label: {
                        Label("Automations", systemImage: "square.stack.3d.up")
                    }
                } footer: {
                    Text("Samples sent so far: \(totalSent.formatted()). \"Last read by the coach\" is the last time ChatGPT (recognised by its user agent) opened the link with your data. \"What the coach sees\" shows what it reads. \"Charts & exports\" opens in Safari the charts, the latest workouts, the CSV and GPX files and the calendars to subscribe to. \"Automations\" creates data packages by category, for example Health and Sport, each with its own link or upload.")
                }

                WaterSection()

                Section {
                    if calendarAuthorized {
                        LabeledContent("Events sent to the coach", value: Self.relative(lastCalendarAt))
                    } else {
                        Button("Connect the calendar") { Task { await connectCalendar() } }
                    }
                    NavigationLink {
                        CalendarPlanView()
                    } label: {
                        Label("Import the coach's plan", systemImage: "calendar.badge.plus")
                    }
                } header: {
                    Text("Calendar")
                } footer: {
                    Text("The coach sees when you are busy over the next 14 days, only the times: event titles do not reach the coach (they only go to the morning briefing, below). The plan it writes goes into the Workouts calendar and into the Workout section.")
                }

                BriefingSection()

                Section {
                    Button(isSyncing ? "Syncing..." : "Sync now") {
                        Task { await syncNow() }
                    }
                    Button("Choose supplements and medications") {
                        Task { await chooseMedications() }
                    }
                    if let authorizationError {
                        Text(authorizationError).foregroundStyle(.red)
                    }
                } header: {
                    Text("Initial setup")
                } footer: {
                    Text("Only needed the first time, or when \"Need your touch\" shows above. When you add a new supplement in Health, it is Health itself that asks you if you want to share it with HealthBridge.")
                }
                .disabled(isSyncing)
            }
            .navigationTitle("HealthBridge")
            .task { await loadCoachRead() }
            .refreshable { await loadCoachRead() }
        }
    }

    private var status: (icon: String, color: Color, title: String, detail: String) {
        let age = Date().timeIntervalSince1970 - lastSuccessAt
        // "Phone locked" is normal: the next round recovers.
        let realError = !lastError.isEmpty && !lastError.hasPrefix("Phone locked")
        if lastSuccessAt == 0 || needsAuthorization {
            return ("hand.tap.fill", .orange, "Need your touch",
                    "Tap Sync now below and grant access to all data.")
        }
        if realError {
            return ("exclamationmark.triangle.fill", .orange, "Last upload failed",
                    "\(lastError) Last upload succeeded \(Self.relative(lastSuccessAt)).")
        }
        if age < 24 * 3600 {
            return ("checkmark.circle.fill", .green, "All good",
                    "The data syncs on its own. Last upload \(Self.relative(lastSuccessAt)).")
        }
        return ("clock.badge.exclamationmark.fill", .orange, "No upload in over a day",
                "Last upload \(Self.relative(lastSuccessAt)). It usually fixes itself: if it stays like this, tap Sync now.")
    }

    private func syncNow() async {
        isSyncing = true
        defer { isSyncing = false }
        authorizationError = nil
        do {
            try await SyncEngine.shared.requestAuthorization()
        } catch {
            authorizationError = "Access to data not granted: \(error.localizedDescription)"
            return
        }
        await SyncEngine.shared.sync()
    }

    private func connectCalendar() async {
        do {
            calendarAuthorized = try await CalendarBridge.requestAccess()
            if calendarAuthorized { try await SyncEngine.shared.syncCalendar(force: true) }
        } catch {
            authorizationError = "Calendar not connected: \(error.localizedDescription)"
        }
    }

    private func chooseMedications() async {
        isSyncing = true
        defer { isSyncing = false }
        authorizationError = nil
        do {
            try await SyncEngine.shared.requestMedicationAuthorization()
        } catch {
            authorizationError = "Medication selection not completed: \(error.localizedDescription)"
            return
        }
        await SyncEngine.shared.sync()
    }

    // Asks the server when ChatGPT last opened the link.
    private func loadCoachRead() async {
        guard let read = try? await ServerStatus.load().lastCoachRead else { return }
        lastCoachRead = read
    }

    private static func relative(_ timestamp: Double) -> String {
        guard timestamp > 0 else { return "never" }
        return Date(timeIntervalSince1970: timestamp).formatted(.relative(presentation: .named))
    }
}

#Preview {
    ContentView()
}
