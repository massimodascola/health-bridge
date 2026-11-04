import BackgroundTasks
import SwiftUI
import UIKit

@main
struct HealthBridgeApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        // Two sections for now: training and everything else (status, water, calendar, coach). Final structure comes from the design on Claude Design.
        WindowGroup {
            TabView {
                Tab("Workout", systemImage: "dumbbell.fill") { TrainingHomeView() }
                Tab("Health", systemImage: "heart.text.square.fill") { ContentView() }
            }
        }
        // On every open (even from widget) we send what we have: before asking the coach anything, just open HealthBridge briefly.
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            // Opening the app sends agenda and Reminders to the briefing immediately, without waiting 15 minutes between sends: what you just logged arrives right away.
            Task {
                await BriefingAgenda.syncIfDue(force: true)
                await SyncEngine.shared.sync()
            }
            SyncEngine.scheduleRefresh()
            TrainingLive.restoreIfNeeded()
            BriefingLocation.shared.refresh()
        }
    }
}

// iOS can launch the app in background when new data arrives: HealthKit observers must be registered here, on every launch, before any screen.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        SyncEngine.startObserving()
        BGTaskScheduler.shared.register(forTaskWithIdentifier: SyncEngine.refreshTaskID, using: nil) { task in
            guard let task = task as? BGAppRefreshTask else { return task.setTaskCompleted(success: false) }
            SyncEngine.handleRefresh(task)
        }
        SyncEngine.scheduleRefresh()
        // Also location for the briefing: iOS relaunches the app when you move.
        BriefingLocation.shared.start()
        return true
    }
}
