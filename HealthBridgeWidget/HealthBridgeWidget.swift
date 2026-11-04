import SwiftUI
import WidgetKit

// HealthBridge widget, for the Home Screen and Lock Screen: shows whether data
// reaches the server and when the coach last read it, plus sleep, resting HR, HRV, and steps.
// Reads /status from the server roughly every 30 minutes; the app updates it after each upload.

@main
struct HealthBridgeWidgets: WidgetBundle {
    var body: some Widget {
        StatusWidget()
        WaterWidget()
        WaterControl()
        TrainingLiveActivity()
    }
}

struct StatusWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "status", provider: StatusProvider()) { entry in
            StatusView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("HealthBridge")
        .description("Whether data reaches the server, when the coach last read it, and today's values.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular, .accessoryInline])
    }
}

struct StatusEntry: TimelineEntry {
    let date: Date
    let status: ServerStatus?
}

struct StatusProvider: TimelineProvider {
    func placeholder(in context: Context) -> StatusEntry {
        StatusEntry(date: .now, status: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (StatusEntry) -> Void) {
        Task { completion(StatusEntry(date: .now, status: try? await ServerStatus.load())) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<StatusEntry>) -> Void) {
        Task {
            let entry = StatusEntry(date: .now, status: try? await ServerStatus.load())
            completion(Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(30 * 60))))
        }
    }
}

struct StatusView: View {
    let entry: StatusEntry
    @Environment(\.widgetFamily) private var family

    // Green if the last upload was less than 3 hours ago: iOS wakes the app about once an hour.
    private var state: (icon: String, color: Color, title: String) {
        guard let status = entry.status else { return ("wifi.slash", .gray, "Server unreachable") }
        guard let last = status.lastIngest else { return ("hand.tap.fill", .orange, "No uploads") }
        if entry.date.timeIntervalSince(last) < 3 * 3600 { return ("checkmark.circle.fill", .green, "Data arriving") }
        return ("clock.badge.exclamationmark.fill", .orange, "Uploads stalled")
    }

    var body: some View {
        switch family {
        case .accessoryInline:
            if let last = entry.status?.lastIngest {
                Label { Text("Health sent \(Text(last, style: .relative)) ago") } icon: { Image(systemName: state.icon) }
            } else {
                Label(state.title, systemImage: state.icon)
            }
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 1) {
                Label(state.title, systemImage: state.icon).font(.headline).widgetAccentable()
                if let last = entry.status?.lastIngest {
                    Text("Upload \(Text(last, style: .relative)) ago")
                }
                if let sleep = entry.status?.latest?.sleepMinutes {
                    Text("Sleep \(Self.hours(sleep))")
                }
            }
            .font(.caption)
        case .systemMedium:
            HStack(alignment: .top, spacing: 16) {
                summary
                Divider()
                values
            }
        default:
            summary
        }
    }

    private var summary: some View {
        VStack(alignment: .leading, spacing: 6) {
            Image(systemName: state.icon).font(.title2).foregroundStyle(state.color)
            Text(state.title).font(.headline)
            if let last = entry.status?.lastIngest {
                Text("Upload \(Text(last, style: .relative)) ago").font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            if let read = entry.status?.lastCoachRead {
                Text("Coach: \(read.formatted(.relative(presentation: .named)))")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var values: some View {
        let latest = entry.status?.latest
        return VStack(alignment: .leading, spacing: 6) {
            row("Sleep", latest?.sleepMinutes.map(Self.hours))
            row("Resting HR", latest?.restingHr.map { "\(Int($0)) bpm" })
            row("HRV", latest?.hrvMs.map { "\(Int($0)) ms" })
            row("Steps today", latest?.stepsToday.map { Int($0).formatted() })
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func row(_ label: String, _ value: String?) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Text(value ?? "n/a").font(.subheadline.weight(.semibold))
        }
    }

    private static func hours(_ minutes: Double) -> String {
        let total = Int(minutes.rounded())
        return "\(total / 60) h \(String(format: "%02d", total % 60))"
    }
}
