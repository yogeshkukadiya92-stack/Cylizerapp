import Foundation
import Observation
@MainActor @Observable final class AppModel {
  enum Session { case signedOut, signedIn }
  var session: Session = .signedOut; var organizations: [Organization] = []; var selectedOrganization: Organization?; var leads: [Lead] = []; var metrics: [Metric] = []; var errorMessage: String?; var isLoading = false
  let client: APIClient; let offlineQueue = OfflineQueue()
  init(client: APIClient) { self.client = client }
  func signIn(accessToken: String) async { await client.authenticate(token: accessToken); session = .signedIn; await refresh() }
  func signOut() async { await client.authenticate(token: nil); session = .signedOut; leads = []; metrics = [] }
  func refresh(query: String = "") async { isLoading = true; defer { isLoading = false }; do { let encoded = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""; let page: LeadPage = try await client.request("/v1/leads?queue=all&search=\(encoded)"); leads = page.items; errorMessage = nil } catch is CancellationError { return } catch { errorMessage = "Could not refresh. Your saved edits will retry automatically." } }
  func updateLead(_ lead: Lead, status: String, note: String) async { let body = (try? JSONEncoder().encode(["statusId": status, "note": note])) ?? Data(); do { let _: Lead = try await client.request("/v1/leads/\(lead.id)", method: "PATCH", body: body, idempotencyKey: UUID().uuidString.lowercased()); await refresh() } catch { await offlineQueue.enqueue(path: "/v1/leads/\(lead.id)", method: "PATCH", body: body); errorMessage = "Update saved offline and will retry." } }
}
