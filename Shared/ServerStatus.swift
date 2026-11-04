import Foundation

// Status read from server (GET /status): last upload from phone, last read by the
// coach and latest values. Used by the app and the widget.
struct ServerStatus: Decodable {
    struct Read: Decodable {
        let at: String
    }

    // Same fields as latest.json (server/src/exports.ts).
    struct Latest: Decodable {
        let updatedAt: String?
        let coachLastRead: String?
        let sleepMinutes: Double?
        let restingHr: Double?
        let hrvMs: Double?
        let stepsToday: Double?
        let activeEnergyToday: Double?
        let exerciseMinutesToday: Double?
        let lastWorkout: String?
        let lastWorkoutStart: String?
    }

    let lastLinkRead: Read?
    let latest: Latest?

    var lastIngest: Date? { Self.date(latest?.updatedAt) }
    var lastCoachRead: Date? { Self.date(lastLinkRead?.at) }

    static func load() async throws -> ServerStatus {
        var request = URLRequest(url: Secrets.serverURL.appending(path: "status"))
        request.setValue("Bearer \(Secrets.readToken)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 15
        let (data, _) = try await URLSession.shared.data(for: request)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(ServerStatus.self, from: data)
    }

    private static func date(_ iso: String?) -> Date? {
        iso.flatMap { ISO8601DateFormatter().date(from: $0) }
    }
}

extension Secrets {
    // Page with charts & exports, behind the same token as the coach link.
    static var dashboardURL: URL { serverURL.appending(path: "data/\(shareToken)/") }
}
