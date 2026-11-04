import EventKit
import Foundation
import UIKit

// Calendar for the coach (2026-10-11).
// * Reading: events from all iPhone calendars (iCloud, work...) in the next
//   14 days, ONLY times: titles don't go to the coach (they only go to the morning
//   briefing, see Briefing/BriefingAgenda.swift). Plus workouts from the
//   "Workouts" calendar, with title and notes, because the coach wrote them.
// * Writing: the plan the coach writes in a fixed block goes into the
//   "Workouts" calendar, created by the app on first launch (on iCloud if available, so it's visible on Mac too).
enum CalendarBridge {
    static let store = EKEventStore()
    static let calendarTitle = "Workouts"
    static let daysAhead = 14
    private static let calendarKey = "calendar.workoutCalendarID"

    static var isAuthorized: Bool { EKEventStore.authorizationStatus(for: .event) == .fullAccess }

    static func requestAccess() async throws -> Bool {
        try await store.requestFullAccessToEvents()
    }

    // MARK: Reading

    struct Busy: Encodable {
        let start: String
        let end: String
        let allDay: Bool
    }

    struct Planned: Encodable {
        let start: String
        let end: String
        let title: String
        let notes: String?
    }

    struct Payload: Encodable {
        let from: String
        let busy: [Busy]
        let planned: [Planned]
    }

    // Events from today to 14 days, planned workouts also from the past 14 days
    // (needed by the coach to compare planned vs done).
    static func snapshot(now: Date = Date()) -> Payload? {
        guard isAuthorized else { return nil }
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: now)
        let past = calendar.date(byAdding: .day, value: -daysAhead, to: today)!
        let future = calendar.date(byAdding: .day, value: daysAhead, to: today)!
        let workouts = try? workoutCalendar(create: false)
        let iso = ISO8601DateFormatter()

        // Birthdays and events marked as "free" don't occupy time; all-day events
        // count only if marked as busy (holidays don't).
        let others = store.calendars(for: .event).filter {
            $0.calendarIdentifier != workouts?.calendarIdentifier && $0.type != .birthday
        }
        let busy: [Busy] = others.isEmpty ? [] : store
            .events(matching: store.predicateForEvents(withStart: today, end: future, calendars: others))
            .filter { event in
                if event.attendees?.first(where: \.isCurrentUser)?.participantStatus == .declined { return false }
                if event.isAllDay { return event.availability == .busy || event.availability == .unavailable }
                return event.availability != .free
            }
            .map { Busy(start: iso.string(from: $0.startDate), end: iso.string(from: $0.endDate), allDay: $0.isAllDay) }

        let planned: [Planned] = workouts.map { workoutCalendar in
            store.events(matching: store.predicateForEvents(withStart: past, end: future, calendars: [workoutCalendar]))
                .map { Planned(start: iso.string(from: $0.startDate), end: iso.string(from: $0.endDate),
                               title: $0.title ?? "Workout", notes: $0.notes) }
        } ?? []

        return Payload(from: iso.string(from: past), busy: busy, planned: planned)
    }

    // MARK: Writing

    // Workouts already in the calendar from the first day of the plan onward: the plan replaces them.
    static func plannedCount(from sessions: [PlannedWorkout]) -> Int {
        guard let calendar = try? workoutCalendar(create: false), let range = replaceRange(sessions) else { return 0 }
        return store.events(matching: store.predicateForEvents(withStart: range.start, end: range.end, calendars: [calendar])).count
    }

    static func apply(_ sessions: [PlannedWorkout]) throws -> (removed: Int, added: Int) {
        guard let range = replaceRange(sessions), let calendar = try workoutCalendar(create: true) else { return (0, 0) }
        let existing = store.events(matching: store.predicateForEvents(withStart: range.start, end: range.end, calendars: [calendar]))
        for event in existing {
            try store.remove(event, span: .thisEvent, commit: false)
        }
        for session in sessions {
            let event = EKEvent(eventStore: store)
            event.calendar = calendar
            event.title = session.title
            // In the event notes also the exercises, so they're readable from Calendar.
            let exercises = session.exercises.map { "\($0.name): \($0.target)" }
            event.notes = ([session.notes].compactMap { $0 } + exercises).joined(separator: "\n").nilIfBlank
            event.startDate = session.start
            event.endDate = session.start.addingTimeInterval(TimeInterval(session.minutes * 60))
            event.availability = .busy
            try store.save(event, span: .thisEvent, commit: false)
        }
        try store.commit()
        return (existing.count, sessions.count)
    }

    private static func replaceRange(_ sessions: [PlannedWorkout]) -> DateInterval? {
        guard let first = sessions.first?.start else { return nil }
        let start = Calendar.current.startOfDay(for: first)
        return DateInterval(start: start, end: Calendar.current.date(byAdding: .year, value: 1, to: start)!)
    }

    private static func workoutCalendar(create: Bool) throws -> EKCalendar? {
        if let id = UserDefaults.standard.string(forKey: calendarKey), let calendar = store.calendar(withIdentifier: id) {
            return calendar
        }
        if let calendar = store.calendars(for: .event).first(where: { $0.title == calendarTitle && $0.allowsContentModifications }) {
            UserDefaults.standard.set(calendar.calendarIdentifier, forKey: calendarKey)
            return calendar
        }
        guard create else { return nil }
        let calendar = EKCalendar(for: .event, eventStore: store)
        calendar.title = calendarTitle
        calendar.cgColor = UIColor.systemOrange.cgColor
        calendar.source = store.sources.first { $0.sourceType == .calDAV && $0.title == "iCloud" }
            ?? store.defaultCalendarForNewEvents?.source
            ?? store.sources.first { $0.sourceType == .local }
        try store.saveCalendar(calendar, commit: true)
        UserDefaults.standard.set(calendar.calendarIdentifier, forKey: calendarKey)
        return calendar
    }
}

private extension String {
    var nilIfBlank: String? { isEmpty ? nil : self }
}
