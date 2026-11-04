import SwiftUI
import UIKit

// Automations, modeled after Health Auto Export: data packages with a name, chosen
// by category (e.g. Health, Sport, Other). Each is a private link to give to an
// AI assistant project or Home Assistant, or an automatic delivery to a web address
// every N hours, done by the server: the phone doesn't need to be unlocked.
// They're saved on the server (server/src/automations.ts) with the write token.

struct DataCategory: Decodable, Identifiable, Hashable {
    let id: String
    let label: String
    let english: String
}

struct Automation: Codable, Identifiable, Hashable {
    var id = ""
    var name = ""
    var categories: [String] = []
    var days = 14
    var format = "text"
    var destination = "link"
    var webhookUrl: String?
    var webhookHeader: String?
    var everyHours = 24
    var enabled = true
    // Read-only, computed by the server.
    var url: String?
    var lastReadAt: String?
    var lastReadBy: String?
    var lastRunAt: String?
    var lastRunOk: Bool?
    var lastRunDetail: String?
}

enum AutomationAPI {
    struct List: Decodable {
        let categories: [DataCategory]
        let automations: [Automation]
    }

    struct Log: Decodable {
        struct Run: Decodable, Hashable {
            let at: String
            let ok: Bool
            let detail: String?
        }
        struct Read: Decodable, Hashable {
            let at: String
            let by: String
        }
        let runs: [Run]
        let reads: [Read]
    }

    struct RunResult: Decodable {
        let ok: Bool
        let detail: String
    }

    private struct Deleted: Decodable {
        let deleted: String
    }

    private struct ServerError: Decodable, LocalizedError {
        let error: String
        var errorDescription: String? { error }
    }

    static func list() async throws -> List { try await call("automations") }
    static func log(_ id: String) async throws -> Log { try await call("automations/\(id)/log") }
    static func run(_ id: String) async throws -> RunResult { try await call("automations/\(id)/run", method: "POST") }

    static func save(_ automation: Automation) async throws -> Automation {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        return try await call("automations", method: "POST", body: try encoder.encode(automation))
    }

    static func delete(_ id: String) async throws {
        let _: Deleted = try await call("automations/\(id)", method: "DELETE")
    }

    private static func call<T: Decodable>(_ path: String, method: String = "GET", body: Data? = nil) async throws -> T {
        var request = URLRequest(url: Secrets.serverURL.appending(path: path))
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue("Bearer \(Secrets.ingestToken)", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw (try? decoder.decode(ServerError.self, from: data))
                ?? ServerError(error: "The server responded with \((response as? HTTPURLResponse)?.statusCode ?? 0).")
        }
        return try decoder.decode(T.self, from: data)
    }
}

struct AutomationsView: View {
    @State private var categories: [DataCategory] = []
    @State private var automations: [Automation] = []
    @State private var error: String?
    @State private var loaded = false

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 2) {
                    Text("AI coach")
                    Text("All data, last 14 days, plus history").font(.caption).foregroundStyle(.secondary)
                }
            } header: {
                Text("Main link")
            } footer: {
                Text("This is the link in your coach's instructions: it always contains everything.")
            }

            Section {
                ForEach(automations) { automation in
                    NavigationLink(value: automation) {
                        AutomationRow(automation: automation, categories: categories)
                    }
                }
                if loaded && automations.isEmpty {
                    Text("No automations. Tap + to create one.").foregroundStyle(.secondary)
                }
            } header: {
                Text("Automations")
            } footer: {
                Text("Each automation is a data package chosen by category: a private link to give to an AI assistant or Home Assistant, or an automatic delivery to a web address.")
            }

            if let error {
                Section { Text(error).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Automations")
        .navigationDestination(for: Automation.self) { automation in
            AutomationEditor(automation: automation, categories: categories, onChange: reload)
        }
        .toolbar {
            NavigationLink {
                AutomationEditor(automation: Automation(), categories: categories, onChange: reload)
            } label: {
                Label("New automation", systemImage: "plus")
            }
            .disabled(categories.isEmpty)
        }
        .task { await reload() }
        .refreshable { await reload() }
    }

    private func reload() async {
        do {
            let list = try await AutomationAPI.list()
            categories = list.categories
            automations = list.automations
            error = nil
        } catch {
            self.error = "Automations not loaded: \(error.localizedDescription)"
        }
        loaded = true
    }
}

private struct AutomationRow: View {
    let automation: Automation
    let categories: [DataCategory]

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: automation.destination == "webhook" ? "paperplane.fill" : "link")
                .foregroundStyle(automation.enabled ? Color.accentColor : .secondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(automation.name)
                Text(categories.filter { automation.categories.contains($0.id) }.map(\.label).joined(separator: ", "))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                Text(status).font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    private var status: String {
        if !automation.enabled { return "Disabled" }
        if automation.destination == "webhook" {
            guard let at = automation.lastRunAt.flatMap(Self.date) else { return "No deliveries yet" }
            let outcome = automation.lastRunOk == true ? "succeeded" : "failed (\(automation.lastRunDetail ?? "error"))"
            return "Last delivery \(outcome), \(at.formatted(.relative(presentation: .named)))"
        }
        guard let at = automation.lastReadAt.flatMap(Self.date) else { return "Link never opened" }
        return "Read by \(automation.lastReadBy ?? "someone") \(at.formatted(.relative(presentation: .named)))"
    }

    static func date(_ iso: String) -> Date? { ISO8601DateFormatter().date(from: iso) }
}

struct AutomationEditor: View {
    @State var automation: Automation
    let categories: [DataCategory]
    let onChange: () async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var saving = false
    @State private var message: String?
    @State private var log: AutomationAPI.Log?
    @State private var confirmDelete = false

    private var isNew: Bool { automation.id.isEmpty }

    // Starter templates for common cases: can be changed afterward.
    private static let presets: [(name: String, categories: [String])] = [
        ("Health", ["sleep", "heart", "body", "supplements", "symptoms", "mood", "alerts", "history"]),
        ("Sport", ["workouts", "activity", "heart", "sleep", "history"]),
        ("Other", ["nutrition", "mobility"]),
    ]

    var body: some View {
        Form {
            if isNew {
                Section {
                    HStack {
                        ForEach(Self.presets, id: \.name) { preset in
                            Button(preset.name) {
                                automation.name = preset.name
                                automation.categories = preset.categories
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                } header: {
                    Text("Start from a template")
                }
            }

            Section {
                TextField("Name, e.g. Health", text: $automation.name)
                Toggle("Active", isOn: $automation.enabled)
            }

            Section {
                ForEach(categories) { category in
                    Toggle(category.label, isOn: included(category.id))
                }
            } header: {
                Text("What to include")
            } footer: {
                Text("Only data from these categories. The page tells the reader that other data isn't included, so they don't mistake it for missing.")
            }

            Section("Period and format") {
                Picker("Period", selection: $automation.days) {
                    Text("Today").tag(1)
                    Text("7 days").tag(7)
                    Text("14 days").tag(14)
                    Text("31 days").tag(31)
                }
                Picker("Format", selection: $automation.format) {
                    Text("Text, for AI assistants").tag("text")
                    Text("JSON, for programs").tag("json")
                }
            }

            Section {
                Picker("Destination", selection: $automation.destination) {
                    Text("Private link").tag("link")
                    Text("Deliver to a web address").tag("webhook")
                }
                if automation.destination == "webhook" {
                    TextField("https://...", text: text($automation.webhookUrl))
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Optional header (Name: value)", text: text($automation.webhookHeader))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Picker("Every", selection: $automation.everyHours) {
                        Text("hour").tag(1)
                        Text("3 hours").tag(3)
                        Text("6 hours").tag(6)
                        Text("12 hours").tag(12)
                        Text("24 hours").tag(24)
                    }
                }
            } header: {
                Text("Destination")
            } footer: {
                Text(automation.destination == "webhook"
                     ? "The server sends the data with a POST in JSON to the address, even with the phone locked. The header is for a token, e.g. Authorization: Bearer ..."
                     : "A private address with only the chosen data. After saving you can copy it, with ready-to-use instructions for an AI assistant.")
            }

            if !isNew, automation.destination == "link", let url = automation.url {
                Section("Link") {
                    Button("Copy instructions for the assistant") { copy(instructions(url), "Instructions copied: paste them at the end of your assistant's instructions.") }
                    Button("Copy link only") { copy(url, "Link copied.") }
                    NavigationLink("Preview") { SummaryView(title: automation.name, url: URL(string: url)) }
                }
            }

            if !isNew, automation.destination == "webhook" {
                Section {
                    Button("Send now") { Task { await runNow() } }
                }
            }

            if let message {
                Section { Text(message) }
            }

            if let log, !isNew {
                Section("Log") {
                    if automation.destination == "webhook" {
                        if log.runs.isEmpty { Text("No deliveries yet").foregroundStyle(.secondary) }
                        ForEach(log.runs, id: \.self) { run in
                            LabeledContent(Self.when(run.at)) {
                                Label(run.detail ?? "", systemImage: run.ok ? "checkmark.circle" : "xmark.octagon")
                                    .foregroundStyle(run.ok ? .green : .red)
                            }
                        }
                    } else {
                        if log.reads.isEmpty { Text("Link never opened").foregroundStyle(.secondary) }
                        ForEach(log.reads, id: \.self) { read in
                            LabeledContent(Self.when(read.at), value: read.by)
                        }
                    }
                }
            }

            if !isNew {
                Section {
                    Button("Delete automation", role: .destructive) { confirmDelete = true }
                }
            }
        }
        .navigationTitle(isNew ? "New automation" : automation.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            Button(saving ? "Saving..." : "Save") { Task { await save() } }
                .disabled(saving || automation.name.trimmingCharacters(in: .whitespaces).isEmpty || automation.categories.isEmpty)
        }
        .confirmationDialog("Delete \"\(automation.name)\"?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { Task { await delete() } }
        } message: {
            Text("The link stops working immediately, even where you've pasted it.")
        }
        .task { await loadLog() }
    }

    private func included(_ id: String) -> Binding<Bool> {
        Binding(
            get: { automation.categories.contains(id) },
            set: { on in
                automation.categories.removeAll { $0 == id }
                if on { automation.categories.append(id) }
            }
        )
    }

    private func text(_ binding: Binding<String?>) -> Binding<String> {
        Binding(get: { binding.wrappedValue ?? "" }, set: { binding.wrappedValue = $0.isEmpty ? nil : $0 })
    }

    // Block to paste into the instructions of an AI assistant project.
    private func instructions(_ url: String) -> String {
        let topics = categories.filter { automation.categories.contains($0.id) }.map(\.english).joined(separator: "; ")
        return """
        Apple Health data: \(automation.name)
        My Apple Health data about \(topics) is at this private link, updated automatically several times a day. Open it with your web tool, copying it exactly, character by character:

        \(url)

        Open it before any answer on these topics. It contains only these categories: other health data is not missing, it is simply not included here. Your web tool returns the copy saved at its previous visit: always open the link twice in a row and use only the second result. Its first line ("Page generated") must be a few minutes old at most; if not, tell me. "n/a" means no data for that day: do not fill gaps or invent values. If you cannot open the link, say so in one line and never answer as if you had read it. Never repeat the link in your replies.
        """
    }

    private func copy(_ text: String, _ confirmation: String) {
        UIPasteboard.general.string = text
        message = confirmation
    }

    private func save() async {
        saving = true
        defer { saving = false }
        // Categories in catalog order, so the page always lists them the same way.
        automation.categories = categories.map(\.id).filter(automation.categories.contains)
        do {
            let wasNew = isNew
            automation = try await AutomationAPI.save(automation)
            message = wasNew && automation.destination == "link"
                ? "Saved. Below you can copy the instructions with the link."
                : "Saved."
            await onChange()
            await loadLog()
        } catch {
            message = "Not saved: \(error.localizedDescription)"
        }
    }

    private func runNow() async {
        message = "Sending..."
        do {
            let result = try await AutomationAPI.run(automation.id)
            message = result.ok ? "Sent (\(result.detail))." : "Send failed: \(result.detail)."
            await onChange()
            await loadLog()
        } catch {
            message = "Send failed: \(error.localizedDescription)"
        }
    }

    private func delete() async {
        do {
            try await AutomationAPI.delete(automation.id)
            await onChange()
            dismiss()
        } catch {
            message = "Not deleted: \(error.localizedDescription)"
        }
    }

    private func loadLog() async {
        guard !isNew else { return }
        log = try? await AutomationAPI.log(automation.id)
    }

    private static func when(_ iso: String) -> String {
        ISO8601DateFormatter().date(from: iso)?.formatted(date: .abbreviated, time: .shortened) ?? iso
    }
}
