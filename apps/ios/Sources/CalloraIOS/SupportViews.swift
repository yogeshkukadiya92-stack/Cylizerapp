import SwiftUI
struct NotificationsView: View {
  var body: some View { List { Label("Notifications hide lead and call details on the lock screen by default.", systemImage: "lock.shield") }.navigationTitle("Notifications") }
}
struct SettingsView: View {
  @Bindable var model: AppModel
  var body: some View {
    Form {
      Section("Organization") { Text(model.selectedOrganization?.name ?? "Current organization") }
      Section("Device & privacy") {
        NavigationLink("Manage sessions") { Text("Active sessions are managed with the same server permissions as web.").padding() }
        Text("Regional default-dialer capabilities are disabled in this baseline build.").font(.footnote).foregroundStyle(.secondary)
      }
      Button("Sign out", role: .destructive) { Task { await model.signOut() } }
    }.navigationTitle("Settings")
  }
}
