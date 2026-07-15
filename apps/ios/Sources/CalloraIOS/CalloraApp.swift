import SwiftUI

@main struct CalloraApp: App {
  @State private var model = AppModel(client: APIClient(baseURL: URL(string: ProcessInfo.processInfo.environment["CALLORA_API_URL"] ?? "http://127.0.0.1:4100")!))
  var body: some Scene { WindowGroup { RootView(model: model) } }
}
enum AppTab: Hashable { case leads, metrics, notifications, settings }
struct RootView: View {
  @Bindable var model: AppModel
  @State private var tab: AppTab = .leads
  var body: some View {
    Group {
      if case .signedOut = model.session { SignInView(model: model) }
      else {
        TabView(selection: $tab) {
          NavigationStack { LeadsView(model: model) }.tabItem { Label("Leads", systemImage: "person.2") }.tag(AppTab.leads)
          NavigationStack { MetricsView(model: model) }.tabItem { Label("Metrics", systemImage: "chart.bar") }.tag(AppTab.metrics)
          NavigationStack { NotificationsView() }.tabItem { Label("Alerts", systemImage: "bell") }.tag(AppTab.notifications)
          NavigationStack { SettingsView(model: model) }.tabItem { Label("Settings", systemImage: "gear") }.tag(AppTab.settings)
        }
      }
    }
  }
}
struct SignInView: View {
  @Bindable var model: AppModel
  @State private var token = ""
  var body: some View {
    NavigationStack {
      Form {
        Section("Secure sign-in") {
          SecureField("Access token", text: $token).textContentType(.password)
          Button("Sign in") { Task { await model.signIn(accessToken: token) } }.disabled(token.isEmpty)
        }
        Section { Text("Callora for iPhone provides CRM workflows. It does not synchronize general iOS cellular call history.").font(.footnote).foregroundStyle(.secondary) }
      }.navigationTitle("Callora")
    }
  }
}
