import CoreLocation
import Foundation
import MapKit
import UIKit

// Location for the morning briefing (2026-10-24, sent to your own briefing service).
// The briefing weather is for your current location: the app sends
// the briefing Worker the last location, rounded to about one kilometer, along with
// the city name.
// * When you move: iOS "significant changes" (a few hundred meters) wake the app
//   even when it is closed. The "Always" permission is required.
// * On every app launch: a single reading.
// Sent only to the briefing, never to the health server or the coach. The Worker keeps
// only the last location: no history of movements.
@MainActor
final class BriefingLocation: NSObject, ObservableObject, CLLocationManagerDelegate {
    static let shared = BriefingLocation()
    static let lastSentKey = "briefing.locationSentAt"
    static let lastPlaceKey = "briefing.locationPlace"
    static let lastErrorKey = "briefing.locationError"

    // Skip sending only if you have moved less than one kilometer or less than 30 minutes have passed.
    private static let minDistance: CLLocationDistance = 1000
    private static let minInterval: TimeInterval = 30 * 60

    @Published private(set) var authorization: CLAuthorizationStatus
    private let manager = CLLocationManager()
    private let defaults = UserDefaults.standard
    private var lastSent: CLLocation?
    // After "While Using the App" it asks for "Always" immediately, but only if the request came from the button.
    private var askAlways = false

    override init() {
        authorization = manager.authorizationStatus
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyKilometer
    }

    // On every launch, including when iOS wakes the app for a movement.
    func start() {
        if manager.authorizationStatus == .authorizedAlways {
            manager.startMonitoringSignificantLocationChanges()
        }
    }

    // When the app is opened.
    func refresh() {
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse: manager.requestLocation()
        default: break
        }
    }

    // From the "Enable location" button: first "While Using the App", then "Always".
    func requestAccess() {
        askAlways = true
        switch manager.authorizationStatus {
        case .notDetermined: manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse: manager.requestAlwaysAuthorization()
        default: break
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            authorization = manager.authorizationStatus
            if authorization == .authorizedWhenInUse && askAlways {
                askAlways = false
                manager.requestAlwaysAuthorization()
            }
            start()
            refresh()
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        Task { @MainActor in await send(location) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // "Location not yet known" resolves itself: retry on the next pass.
        if (error as? CLError)?.code == .locationUnknown { return }
        Task { @MainActor in defaults.set("Location not read: \(error.localizedDescription)", forKey: Self.lastErrorKey) }
    }

    private struct Payload: Encodable {
        let latitude: Double
        let longitude: Double
        let name: String?
        let at: String
    }

    private func send(_ location: CLLocation) async {
        if let lastSent, location.distance(from: lastSent) < Self.minDistance,
           location.timestamp.timeIntervalSince(lastSent.timestamp) < Self.minInterval { return }
        // Woken by iOS for a movement, the app has only a few seconds: it requests more
        // time to finish getting the city name and sending.
        let task = UIApplication.shared.beginBackgroundTask(withName: "briefing.location")
        defer { UIApplication.shared.endBackgroundTask(task) }

        let name = await Self.cityName(location)
        let payload = Payload(
            latitude: (location.coordinate.latitude * 100).rounded() / 100,
            longitude: (location.coordinate.longitude * 100).rounded() / 100,
            name: name,
            at: ISO8601DateFormatter().string(from: location.timestamp)
        )
        do {
            try await BriefingClient.post("location", body: try JSONEncoder().encode(payload))
            lastSent = location
            defaults.set(Date().timeIntervalSince1970, forKey: Self.lastSentKey)
            defaults.set(name ?? "unnamed location", forKey: Self.lastPlaceKey)
            defaults.removeObject(forKey: Self.lastErrorKey)
        } catch {
            defaults.set("Location: \(error.localizedDescription)", forKey: Self.lastErrorKey)
        }
    }

    // For example "London". The name is calculated by Apple from the precise location, which otherwise does not go out.
    private static func cityName(_ location: CLLocation) async -> String? {
        guard let request = MKReverseGeocodingRequest(location: location) else { return nil }
        request.preferredLocale = .current
        return try? await request.mapItems.first?.addressRepresentations?.cityName
    }
}
