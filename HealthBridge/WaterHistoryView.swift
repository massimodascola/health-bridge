import SwiftUI

// Water history: last 60 days with total, glasses, and goal. Each day opens to see glasses, add retroactively, or delete incorrect ones. Data lives in Health (Browse → Nutrition → Water): what you add there appears here, and vice versa.
struct WaterHistoryView: View {
    @State private var days: [Water.DayTotal] = []
    private let goalMl = Water.goalMl

    var body: some View {
        List {
            Section {
                ForEach(days) { day in
                    NavigationLink {
                        WaterDayView(day: day.day)
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(Self.dayLabel(day.day))
                                Text(day.count == 0 ? "no glasses" : day.count == 1 ? "1 glass" : "\(day.count) glasses")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(Water.liters(day.ml)).monospacedDigit()
                            Image(systemName: day.ml >= goalMl ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(day.ml >= goalMl ? .green : .secondary)
                        }
                    }
                }
            } footer: {
                Text("Goal \(Water.liters(goalMl)) per day. The same data is in Health, in Browse → Nutrition → Water.")
            }
        }
        .navigationTitle("Water history")
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        await Water.flushPending()
        days = await Water.history(days: 60)
    }

    static func dayLabel(_ day: Date) -> String {
        if Calendar.current.isDateInToday(day) { return "Today" }
        if Calendar.current.isDateInYesterday(day) { return "Yesterday" }
        return day.formatted(.dateTime.weekday(.wide).day().month(.wide))
    }
}

struct WaterDayView: View {
    let day: Date

    @State private var entries: [Water.Entry] = []
    @State private var time: Date
    @State private var ml = 250
    @State private var message: String?

    init(day: Date) {
        self.day = day
        // Today starts from now, past days start from noon.
        let isToday = Calendar.current.isDateInToday(day)
        _time = State(initialValue: isToday ? Date() : Calendar.current.date(byAdding: .hour, value: 12, to: Calendar.current.startOfDay(for: day))!)
    }

    private var totalMl: Int { entries.reduce(0) { $0 + $1.ml } }

    private var dayRange: ClosedRange<Date> {
        let start = Calendar.current.startOfDay(for: day)
        let end = min(Date(), Calendar.current.date(byAdding: .second, value: 86_399, to: start)!)
        return start...max(start, end)
    }

    var body: some View {
        List {
            Section {
                LabeledContent("Total", value: "\(Water.liters(totalMl)) of \(Water.liters(Water.goalMl))")
                if entries.isEmpty {
                    Text("No glasses logged.").foregroundStyle(.secondary)
                }
                ForEach(entries) { entry in
                    HStack {
                        Text(entry.date.formatted(date: .omitted, time: .shortened)).monospacedDigit()
                        Text("\(entry.ml) ml")
                        Spacer()
                        if !entry.mine {
                            Text(entry.source).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .swipeActions {
                        if entry.mine {
                            Button("Delete", role: .destructive) { Task { await delete(entry) } }
                        }
                    }
                }
            } footer: {
                Text("Swipe left on a glass to delete it. Those logged with other apps are deleted from Health.")
            }

            Section("Add") {
                DatePicker("Time", selection: $time, in: dayRange, displayedComponents: .hourAndMinute)
                Picker("Amount", selection: $ml) {
                    ForEach([150, 250, 330, 500, 750, 1000, 1500, 2000], id: \.self) { value in
                        Text(value >= 1000 ? Water.liters(value) : "\(value) ml").tag(value)
                    }
                }
                Button("Add \(ml >= 1000 ? Water.liters(ml) : "\(ml) ml")") { Task { await add() } }
            }

            if let message {
                Section { Text(message).foregroundStyle(.secondary) }
            }
        }
        .navigationTitle(WaterHistoryView.dayLabel(day))
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        entries = await Water.entries(on: day)
    }

    private func add() async {
        await Water.log(ml, at: time)
        message = "Added \(ml) ml at \(time.formatted(date: .omitted, time: .shortened))."
        await afterChange()
    }

    private func delete(_ entry: Water.Entry) async {
        do {
            try await Water.delete(entry)
            message = "Deleted \(entry.ml) ml."
        } catch {
            message = "Not deleted: \(error.localizedDescription)"
        }
        await afterChange()
    }

    // The day total also goes to the coach: for past days, totals are resent.
    private func afterChange() async {
        await Water.refreshToday()
        await load()
        Task { await SyncEngine.shared.resendDailyTotals(from: day) }
    }
}
