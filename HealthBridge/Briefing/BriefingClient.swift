import Foundation

// Uploads to your morning briefing service (BRIEFING_URL), using the app token
// (Secrets.briefingToken, from scripts/make-secrets.sh).
enum BriefingClient {
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    // Returns the response body (for /agenda: the list of Reminders to send).
    @discardableResult
    static func post(_ path: String, body: Data) async throws -> Data {
        // The simulator has the same tokens as the iPhone: no uploads (see SyncEngine.post).
        #if targetEnvironment(simulator)
        return Data()
        #endif
        guard !Secrets.briefingToken.isEmpty else {
            throw Failure(message: "Briefing token missing: rerun scripts/make-secrets.sh and rebuild.")
        }
        var request = URLRequest(url: Secrets.briefingURL.appending(path: path))
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("Bearer \(Secrets.briefingToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            throw Failure(message: "Upload failed (\(status)): \(String(decoding: data, as: UTF8.self))")
        }
        return data
    }
}
