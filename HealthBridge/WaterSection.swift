import HealthKit
import SwiftUI

// "Water today" on the main screen: how much you have drunk compared to the goal,
// buttons to log a glass, undo the last entry and change the goal.
struct WaterSection: View {
    @State private var todayMl = Water.todayMl
    @State private var goalMl = Water.goalMl
    @State private var todayCount = 0
    @State private var message: String?
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline) {
                    Text(Water.liters(todayMl)).font(.title2.weight(.semibold))
                    Text("of \(Water.liters(goalMl))").foregroundStyle(.secondary)
                    Spacer()
                    Text("\(todayMl * 100 / max(goalMl, 1))%").foregroundStyle(.secondary)
                }
                ProgressView(value: min(1, Double(todayMl) / Double(max(goalMl, 1))))
                    .tint(.blue)
                Text(todayCount == 0 ? "No glasses logged yet today" : todayCount == 1 ? "1 glass today" : "\(todayCount) glasses today")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .padding(.vertical, 4)

            HStack {
                Button("+ 250 ml") { Task { await add(250) } }
                Button("+ 500 ml") { Task { await add(500) } }
                Spacer()
                Button("Undo") { Task { await undo() } }
                    .tint(.secondary)
            }
            .buttonStyle(.bordered)

            NavigationLink {
                WaterHistoryView()
            } label: {
                Label("History and past days", systemImage: "calendar")
            }

            Stepper("Goal \(Water.liters(goalMl)) per day", value: $goalMl, in: 1000...5000, step: 250)
                .onChange(of: goalMl) { _, value in Water.goalMl = value }

            if let message {
                Text(message).font(.footnote).foregroundStyle(.secondary)
            }
        } header: {
            Text("Water today")
        } footer: {
            Text("Every glass goes to the Health app and reaches the coach with the rest. Log it from the Water widget or the Control Center without opening the app.")
        }
        .task { await refresh() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await refresh() } }
        }
    }

    private func add(_ ml: Int) async {
        // The first time, iOS asks for permission to write water to the Health app.
        if HKHealthStore().authorizationStatus(for: Water.type) == .notDetermined {
            try? await SyncEngine.shared.requestAuthorization()
        }
        await Water.log(ml)
        message = nil
        await refresh()
    }

    private func undo() async {
        do {
            if let ml = try await Water.undoLast() {
                message = "Removed \(ml) ml."
            } else {
                message = "Nothing to remove today."
            }
        } catch {
            message = "Failed: \(error.localizedDescription)"
        }
        await refresh()
    }

    private func refresh() async {
        await Water.flushPending()
        await Water.refreshToday()
        todayMl = Water.todayMl
        goalMl = Water.goalMl
        todayCount = await Water.entries(on: Date()).count
    }
}
