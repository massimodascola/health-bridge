import AppIntents
import Foundation
import HealthKit
import WidgetKit

// Water (2026-10-13): the user drinks little and wants to log every glass, even from the widget.
// Each glass goes to Health as "Water" (dietaryWater): from there it reaches the server with
// the rest, without a separate path. Goal and today's total live in the App Group, so
// both the app and the widget see them. Compiled in both targets.
enum Water {
    static let groupID = "group.com.example.healthbridge"
    static let type = HKQuantityType(.dietaryWater)
    static let defaultGoalMl = 2500

    private static let store = HKHealthStore()
    private static let unit = HKUnit.literUnit(with: .milli)
    private static let goalKey = "water.goalMl"
    private static let todayKey = "water.todayMl"
    private static let dayKey = "water.day"
    private static let pendingKey = "water.pending"

    private static var defaults: UserDefaults { UserDefaults(suiteName: groupID) ?? .standard }

    static var goalMl: Int {
        get {
            let value = defaults.integer(forKey: goalKey)
            return value > 0 ? value : defaultGoalMl
        }
        set {
            defaults.set(newValue, forKey: goalKey)
            WidgetCenter.shared.reloadAllTimelines()
        }
    }

    // Today's total as known by the widget: the app updates it after every Health read
    // and the widget button increments it. At midnight it resets to zero.
    static var todayMl: Int {
        defaults.string(forKey: dayKey) == dayString(Date()) ? defaults.integer(forKey: todayKey) : 0
    }

    private static func setToday(_ ml: Int) {
        defaults.set(dayString(Date()), forKey: dayKey)
        defaults.set(max(0, ml), forKey: todayKey)
    }

    // Glasses that couldn't be written to Health (phone locked, permission not
    // yet granted): the app writes them on the next run, with the correct time.
    private struct Pending: Codable {
        let ml: Int
        let at: Date
    }

    private static var pending: [Pending] {
        get { (defaults.data(forKey: pendingKey)).flatMap { try? JSONDecoder().decode([Pending].self, from: $0) } ?? [] }
        set { defaults.set(try? JSONEncoder().encode(newValue), forKey: pendingKey) }
    }

    static func log(_ ml: Int, at date: Date = Date()) async {
        do {
            try await save(ml, at: date)
        } catch {
            pending.append(Pending(ml: ml, at: date))
        }
        // A glass added retroactively, on a past day, doesn't change today's total.
        if Calendar.current.isDateInToday(date) { setToday(todayMl + ml) }
        WidgetCenter.shared.reloadAllTimelines()
    }

    private static func save(_ ml: Int, at date: Date) async throws {
        let quantity = HKQuantity(unit: unit, doubleValue: Double(ml))
        try await store.save(HKQuantitySample(type: type, quantity: quantity, start: date, end: date))
    }

    // From the app, on every sync: writes to Health what remained in the queue.
    static func flushPending() async {
        let queue = pending
        guard !queue.isEmpty else { return }
        var left: [Pending] = []
        for item in queue {
            do { try await save(item.ml, at: item.at) } catch { left.append(item) }
        }
        pending = left
    }

    // From the app: the true today total from Health (including water logged elsewhere), plus the queue.
    static func refreshToday() async {
        let start = Calendar.current.startOfDay(for: Date())
        let descriptor = HKStatisticsQueryDescriptor(
            predicate: .quantitySample(type: type, predicate: HKQuery.predicateForSamples(withStart: start, end: nil)),
            options: .cumulativeSum
        )
        guard let statistics = try? await descriptor.result(for: store) else { return }
        let fromHealth = Int(statistics.sumQuantity()?.doubleValue(for: unit) ?? 0)
        let queued = pending.filter { Calendar.current.isDateInToday($0.at) }.reduce(0) { $0 + $1.ml }
        setToday(fromHealth + queued)
        WidgetCenter.shared.reloadAllTimelines()
    }

    // Removes the last glass logged today by HealthBridge: first from the queue, then from Health.
    static func undoLast() async throws -> Int? {
        var queue = pending
        if let index = queue.lastIndex(where: { Calendar.current.isDateInToday($0.at) }) {
            let removed = queue.remove(at: index)
            pending = queue
            setToday(todayMl - removed.ml)
            WidgetCenter.shared.reloadAllTimelines()
            return removed.ml
        }
        let start = Calendar.current.startOfDay(for: Date())
        let predicate = NSCompoundPredicate(andPredicateWithSubpredicates: [
            HKQuery.predicateForSamples(withStart: start, end: nil),
            HKQuery.predicateForObjects(from: HKSource.default()),
        ])
        let descriptor = HKSampleQueryDescriptor(
            predicates: [.quantitySample(type: type, predicate: predicate)],
            sortDescriptors: [SortDescriptor(\.startDate, order: .reverse)],
            limit: 1
        )
        guard let last = try await descriptor.result(for: store).first else { return nil }
        try await store.delete(last)
        await refreshToday()
        return Int(last.quantity.doubleValue(for: unit))
    }

    // MARK: History, read from Health (including water logged with other apps or in the Health app)

    struct DayTotal: Identifiable, Hashable {
        var id: Date { day }
        let day: Date
        let ml: Int
        let count: Int
    }

    struct Entry: Identifiable, Hashable {
        let id: UUID
        let date: Date
        let ml: Int
        let source: String
        // Health allows deleting only what HealthBridge wrote.
        let mine: Bool
    }

    // The last days, most recent first, including days without water.
    static func history(days: Int) async -> [DayTotal] {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        let start = calendar.date(byAdding: .day, value: -(days - 1), to: today)!
        let samples = await samples(from: start, to: calendar.date(byAdding: .day, value: 1, to: today)!)
        let byDay = Dictionary(grouping: samples) { calendar.startOfDay(for: $0.startDate) }
        return (0..<days).map { offset in
            let day = calendar.date(byAdding: .day, value: -offset, to: today)!
            let list = byDay[day] ?? []
            return DayTotal(day: day, ml: list.reduce(0) { $0 + Int($1.quantity.doubleValue(for: unit)) }, count: list.count)
        }
    }

    static func entries(on day: Date) async -> [Entry] {
        let start = Calendar.current.startOfDay(for: day)
        let mine = HKSource.default()
        return await samples(from: start, to: Calendar.current.date(byAdding: .day, value: 1, to: start)!)
            .sorted { $0.startDate < $1.startDate }
            .map { sample in
                Entry(id: sample.uuid, date: sample.startDate, ml: Int(sample.quantity.doubleValue(for: unit)),
                      source: sample.sourceRevision.source.name, mine: sample.sourceRevision.source == mine)
            }
    }

    static func delete(_ entry: Entry) async throws {
        let descriptor = HKSampleQueryDescriptor(
            predicates: [.quantitySample(type: type, predicate: HKQuery.predicateForObject(with: entry.id))],
            sortDescriptors: []
        )
        guard let sample = try await descriptor.result(for: store).first else { return }
        try await store.delete(sample)
        await refreshToday()
    }

    private static func samples(from start: Date, to end: Date) async -> [HKQuantitySample] {
        let descriptor = HKSampleQueryDescriptor(
            predicates: [.quantitySample(type: type, predicate: HKQuery.predicateForSamples(withStart: start, end: end))],
            sortDescriptors: [SortDescriptor(\.startDate)]
        )
        return (try? await descriptor.result(for: store)) ?? []
    }

    static func liters(_ ml: Int) -> String {
        (Double(ml) / 1000).formatted(.number.precision(.fractionLength(1))) + " L"
    }

    private static func dayString(_ date: Date) -> String {
        let components = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return "\(components.year!)-\(components.month!)-\(components.day!)"
    }
}

// "Log water": used by widget buttons, Control Center, and Shortcuts.
// Requires unlock: with phone locked Health won't accept writes.
struct LogWaterIntent: AppIntent {
    static let title: LocalizedStringResource = "Log water"
    static let description = IntentDescription("Log how much water you drank in Health.")
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Milliliters", default: 250)
    var ml: Int

    init() {}

    init(ml: Int) {
        self.ml = ml
    }

    func perform() async throws -> some IntentResult {
        await Water.log(ml)
        return .result()
    }
}
