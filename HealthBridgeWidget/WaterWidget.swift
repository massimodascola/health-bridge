import AppIntents
import SwiftUI
import WidgetKit

// Water widget: how much you've drunk today vs. your goal, with buttons to log
// a glass without opening the app (LogWaterIntent, in Shared/Water.swift). On the Lock Screen
// it only shows progress: iOS doesn't allow buttons there.

struct WaterWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "water", provider: WaterProvider()) { entry in
            WaterView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Water")
        .description("How much water you've drunk today. Tap + to log a glass.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular])
    }
}

struct WaterEntry: TimelineEntry {
    let date: Date
    let ml: Int
    let goal: Int
}

struct WaterProvider: TimelineProvider {
    func placeholder(in context: Context) -> WaterEntry {
        WaterEntry(date: .now, ml: 1250, goal: Water.defaultGoalMl)
    }

    func getSnapshot(in context: Context, completion: @escaping (WaterEntry) -> Void) {
        completion(WaterEntry(date: .now, ml: Water.todayMl, goal: Water.goalMl))
    }

    // Updates when you log a glass or when the app re-reads Health; resets to zero at midnight.
    func getTimeline(in context: Context, completion: @escaping (Timeline<WaterEntry>) -> Void) {
        let midnight = Calendar.current.startOfDay(for: .now.addingTimeInterval(24 * 3600))
        let entries = [
            WaterEntry(date: .now, ml: Water.todayMl, goal: Water.goalMl),
            WaterEntry(date: midnight, ml: 0, goal: Water.goalMl),
        ]
        completion(Timeline(entries: entries, policy: .after(midnight.addingTimeInterval(60))))
    }
}

struct WaterView: View {
    let entry: WaterEntry
    @Environment(\.widgetFamily) private var family

    private var progress: Double { min(1, Double(entry.ml) / Double(max(entry.goal, 1))) }

    var body: some View {
        switch family {
        case .accessoryCircular:
            Gauge(value: progress) {
                Image(systemName: "drop.fill")
            } currentValueLabel: {
                Text((Double(entry.ml) / 1000).formatted(.number.precision(.fractionLength(1))))
            }
            .gaugeStyle(.accessoryCircularCapacity)
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 2) {
                Label("Water", systemImage: "drop.fill").font(.headline).widgetAccentable()
                Text("\(Water.liters(entry.ml)) of \(Water.liters(entry.goal))")
                ProgressView(value: progress)
            }
        case .systemMedium:
            HStack(spacing: 16) {
                ring.frame(width: 96, height: 96)
                VStack(alignment: .leading, spacing: 8) {
                    Text("Water today").font(.headline)
                    Text("\(Water.liters(entry.ml)) of \(Water.liters(entry.goal))").foregroundStyle(.secondary)
                    HStack { button(250); button(500) }
                }
            }
        default:
            VStack(spacing: 8) {
                ring.frame(width: 72, height: 72)
                HStack(spacing: 6) { button(250); button(500) }
            }
        }
    }

    private var ring: some View {
        ZStack {
            Circle().stroke(.blue.opacity(0.2), lineWidth: 8)
            Circle().trim(from: 0, to: progress)
                .stroke(.blue, style: StrokeStyle(lineWidth: 8, lineCap: .round))
                .rotationEffect(.degrees(-90))
            VStack(spacing: 0) {
                Text((Double(entry.ml) / 1000).formatted(.number.precision(.fractionLength(1))))
                    .font(.title3.weight(.semibold))
                Text("of \((Double(entry.goal) / 1000).formatted(.number.precision(.fractionLength(1)))) L")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    private func button(_ ml: Int) -> some View {
        Button(intent: LogWaterIntent(ml: ml)) {
            Text("+\(ml)").font(.caption.weight(.semibold)).frame(maxWidth: .infinity)
        }
        .tint(.blue)
    }
}

// Button for Control Center, Lock Screen, and Action Button:
// logs 250 ml (asks for unlock if phone is locked).
struct WaterControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.example.healthbridge.water") {
            ControlWidgetButton(action: LogWaterIntent(ml: 250)) {
                Label("Water +250 ml", systemImage: "drop.fill")
            }
        }
        .displayName("Log water")
        .description("Log 250 ml of water in Health.")
    }
}
