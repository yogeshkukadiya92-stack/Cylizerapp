import SwiftUI

struct LeadsView: View {
  @Bindable var model: AppModel
  @State private var query = ""
  var body: some View {
    List(model.leads) { lead in
      NavigationLink(value: lead) { VStack(alignment: .leading) { Text(lead.displayName).font(.headline); Text(lead.statusName).foregroundStyle(.secondary) } }
    }
    .overlay { if model.isLoading { ProgressView() } else if model.leads.isEmpty { ContentUnavailableView("No assigned leads", systemImage: "person.crop.circle.badge.checkmark") } }
    .searchable(text: $query)
    .task(id: query) { try? await Task.sleep(for: .milliseconds(300)); guard !Task.isCancelled else { return }; await model.refresh(query: query) }
    .refreshable { await model.refresh(query: query) }
    .navigationTitle("Assigned leads")
    .navigationDestination(for: Lead.self) { LeadDetailView(model: model, lead: $0) }
    .alert("Sync notice", isPresented: .constant(model.errorMessage != nil)) { Button("OK") { model.errorMessage = nil } } message: { Text(model.errorMessage ?? "") }
  }
}
struct LeadDetailView: View {
  @Bindable var model: AppModel
  let lead: Lead
  @State private var note = ""
  @State private var status = "contacted"
  @Environment(\.openURL) private var openURL
  var body: some View {
    Form {
      Section("Lead") { LabeledContent("Name", value: lead.displayName); LabeledContent("Status", value: lead.statusName) }
      Section("Call") {
        Button { if let url = URL(string: "tel:\(lead.phoneNumber.filter { $0.isNumber || $0 == "+" })") { openURL(url) } } label: { Label("Call with iPhone", systemImage: "phone") }
        Text("After the call, return here to record the outcome.").font(.footnote).foregroundStyle(.secondary)
      }
      Section("Post-call update") {
        Picker("Status", selection: $status) { Text("Contacted").tag("contacted"); Text("Qualified").tag("qualified"); Text("Won").tag("won") }
        TextField("Private note", text: $note, axis: .vertical)
        Button("Save update") { Task { await model.updateLead(lead, status: status, note: note) } }
      }
    }.navigationTitle(lead.displayName)
  }
}
struct MetricsView: View {
  @Bindable var model: AppModel
  var body: some View { List(model.metrics) { metric in LabeledContent(metric.label, value: metric.value) }.overlay { if model.metrics.isEmpty { ContentUnavailableView("Metrics unavailable", systemImage: "chart.bar") } }.navigationTitle("Manager metrics") }
}
