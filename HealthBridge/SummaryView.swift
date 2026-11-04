import SwiftUI

// "What the coach sees": downloads the weekly summary from the server, the same one
// that the coach receives. If today's data appears here, the upload works.
// With an address, it shows an automation link (preview) instead.
struct SummaryView: View {
    var title = "What the coach sees"
    var url: URL?

    @State private var summary: String?
    @State private var error: String?
    @State private var isLoading = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let summary {
                    Text(summary)
                        .font(.callout)
                        .textSelection(.enabled)
                } else if let error {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                } else {
                    ProgressView("Downloading from server...")
                        .frame(maxWidth: .infinity)
                }
            }
            .padding()
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            Button("Refresh", systemImage: "arrow.clockwise") {
                Task { await load() }
            }
            .disabled(isLoading)
        }
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            var request = URLRequest(url: url ?? Secrets.serverURL.appending(path: "summary"))
            if url == nil {
                request.setValue("Bearer \(Secrets.readToken)", forHTTPHeaderField: "Authorization")
            }
            request.timeoutInterval = 20
            let (data, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard status == 200 else {
                error = "The server responded with \(status)."
                return
            }
            summary = String(decoding: data, as: UTF8.self)
            error = nil
        } catch {
            self.error = "Server unreachable: \(error.localizedDescription)"
        }
    }
}

#Preview {
    NavigationStack { SummaryView() }
}
