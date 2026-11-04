import EventKit
import Foundation

// Agenda, birthdays, and Reminders for the morning briefing (2026-10-24).
// Only event times go to the coach (CalendarBridge); the briefing also gets titles,
// both work and personal, because it needs to tell you what's on today. They go only to the
// briefing Worker, never to the health server nor to the coach.
// * Events from all calendars from today to 7 days, including Contacts birthdays.
// * Incomplete reminders from the lists chosen by the briefing service: it names them
//   in its answer to each upload ({"lists": [...]}). From
//   other lists only the names go, so you can pick the right one.
// Runs on every sync, at most every 15 minutes, before health data:
// when sleep arrives and the briefing runs, the agenda is already this morning's.
enum BriefingAgenda {
    static let daysAhead = 7
    static let lastSentKey = "briefing.agendaSentAt"
    static let summaryKey = "briefing.agendaSummary"
    static let lastErrorKey = "briefing.agendaError"
    private static let wantedListsKey = "briefing.wantedLists"

    // The lists to send, as the Worker last said (case-insensitive).
    static var wantedLists: [String] {
        UserDefaults.standard.stringArray(forKey: wantedListsKey) ?? ["Reminders"]
    }
    private static let minInterval: TimeInterval = 15 * 60
    // Calendars that HealthBridge itself publishes (sleep.ics, workouts.ics): if they are
    // subscribed on iPhone they are not commitments.
    private static let ownFeeds: Set<String> = ["Sleep", "Workouts"]

    static var store: EKEventStore { CalendarBridge.store }
    static var remindersAuthorized: Bool { EKEventStore.authorizationStatus(for: .reminder) == .fullAccess }

    static func requestRemindersAccess() async throws -> Bool {
        try await store.requestFullAccessToReminders()
    }

    struct Event: Encodable {
        let start: String
        let end: String
        let allDay: Bool
        let title: String
        let location: String?
        let calendar: String
        // Calendar account (iCloud, Google...), type, and whether you can edit it: needed
        // by the briefing to separate work, personal, and shared calendars.
        let account: String
        let kind: String
        let editable: Bool
        let birthday: Bool
    }

    struct CalendarInfo: Encodable {
        let title: String
        let account: String
        let kind: String
        let editable: Bool
    }

    struct Reminder: Encodable {
        let list: String
        let title: String
        // "2026-10-25" without time, ISO instant with time (dueHasTime).
        let due: String?
        let dueHasTime: Bool
        let priority: Int
        let created: String?
    }

    struct Payload: Encodable {
        let lists: [String]
        let allLists: [String]
        // All calendars read, even those without events: to classify them in the briefing.
        let calendars: [CalendarInfo]
        let events: [Event]
        let reminders: [Reminder]
    }

    private struct Answer: Decodable {
        let lists: [String]
    }

    // Never throws: a problem here must not stop health data upload.
    // The outcome stays in the keys read by the "Morning Briefing" section.
    static func syncIfDue(force: Bool = false) async {
        let defaults = UserDefaults.standard
        let last = defaults.double(forKey: lastSentKey)
        guard force || Date().timeIntervalSince1970 - last > minInterval else { return }
        guard CalendarBridge.isAuthorized || remindersAuthorized else { return }
        store.refreshSourcesIfNecessary()
        let (calendars, events) = upcomingEvents()
        let (lists, allLists, reminders) = await openReminders()
        do {
            let payload = Payload(lists: lists, allLists: allLists, calendars: calendars, events: events, reminders: reminders)
            let answer = try await BriefingClient.post("agenda", body: try JSONEncoder().encode(payload))
            defaults.set(Date().timeIntervalSince1970, forKey: lastSentKey)
            defaults.set(summary(events: events, lists: lists, reminders: reminders), forKey: summaryKey)
            defaults.removeObject(forKey: lastErrorKey)
            // The briefing changed list: resend immediately with the new one.
            if let wanted = try? JSONDecoder().decode(Answer.self, from: answer).lists, wanted != wantedLists {
                defaults.set(wanted, forKey: wantedListsKey)
                await syncIfDue(force: true)
            }
        } catch {
            defaults.set("Agenda: \(error.localizedDescription)", forKey: lastErrorKey)
        }
    }

    private static func upcomingEvents(now: Date = Date()) -> ([CalendarInfo], [Event]) {
        guard CalendarBridge.isAuthorized else { return ([], []) }
        let today = Calendar.current.startOfDay(for: now)
        let end = Calendar.current.date(byAdding: .day, value: daysAhead, to: today)!
        let calendars = store.calendars(for: .event).filter { !($0.type == .subscription && ownFeeds.contains($0.title)) }
        guard !calendars.isEmpty else { return ([], []) }
        let infos = calendars.map {
            CalendarInfo(title: $0.title, account: $0.source?.title ?? "", kind: kindName($0.type), editable: $0.allowsContentModifications)
        }
        let iso = ISO8601DateFormatter()
        let events = store.events(matching: store.predicateForEvents(withStart: today, end: end, calendars: calendars))
            .filter { $0.attendees?.first(where: \.isCurrentUser)?.participantStatus != .declined }
            .map { event in
                Event(start: iso.string(from: event.startDate), end: iso.string(from: event.endDate),
                      allDay: event.isAllDay, title: event.title ?? "(no title)", location: event.location,
                      calendar: event.calendar.title, account: event.calendar.source?.title ?? "",
                      kind: kindName(event.calendar.type), editable: event.calendar.allowsContentModifications,
                      birthday: event.calendar.type == .birthday)
            }
        return (infos, events)
    }

    private static func kindName(_ type: EKCalendarType) -> String {
        switch type {
        case .local: "locale"
        case .calDAV: "caldav"
        case .exchange: "exchange"
        case .subscription: "sottoscritto"
        case .birthday: "compleanni"
        @unknown default: "altro"
        }
    }

    private static func openReminders() async -> (lists: [String], allLists: [String], items: [Reminder]) {
        guard remindersAuthorized else { return ([], [], []) }
        let all = store.calendars(for: .reminder)
        let allLists = Array(Set(all.map(\.title))).sorted()
        let wanted = Set(wantedLists.map { $0.lowercased() })
        let calendars = all.filter { wanted.contains($0.title.lowercased()) }
        guard !calendars.isEmpty else { return ([], allLists, []) }
        let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: calendars)
        let items: [Reminder] = await withCheckedContinuation { continuation in
            store.fetchReminders(matching: predicate) { found in
                let iso = ISO8601DateFormatter()
                continuation.resume(returning: (found ?? []).map { reminder in
                    let (due, hasTime) = dueString(reminder.dueDateComponents, iso: iso)
                    return Reminder(list: reminder.calendar.title, title: reminder.title ?? "(no title)",
                                    due: due, dueHasTime: hasTime, priority: reminder.priority,
                                    created: reminder.creationDate.map { iso.string(from: $0) })
                })
            }
        }
        return (Array(Set(calendars.map(\.title))).sorted(), allLists, items)
    }

    // With time: ISO instant. Without: the date as-is, "2026-10-25".
    private static func dueString(_ components: DateComponents?, iso: ISO8601DateFormatter) -> (String?, Bool) {
        guard let components, let year = components.year, let month = components.month, let day = components.day else {
            return (nil, false)
        }
        if components.hour != nil, let date = Calendar.current.date(from: components) {
            return (iso.string(from: date), true)
        }
        return (String(format: "%04d-%02d-%02d", year, month, day), false)
    }

    // "12 events in 7 days · Reminders 6", for the app section.
    private static func summary(events: [Event], lists: [String], reminders: [Reminder]) -> String {
        let parts = wantedLists.map { title in
            let found = lists.first { $0.lowercased() == title.lowercased() }
            return found.map { name in "\(name) \(reminders.filter { $0.list == name }.count)" } ?? "\(title): list not found"
        }
        let calendar = CalendarBridge.isAuthorized ? "\(events.count) events in \(daysAhead) days" : "calendar not connected"
        let reminderPart = remindersAuthorized ? parts.joined(separator: " · ") : "Reminders not connected"
        return "\(calendar) · \(reminderPart)"
    }
}
