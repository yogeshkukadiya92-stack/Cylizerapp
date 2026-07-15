import Foundation
actor APIClient {
  private let baseURL: URL; private var token: String?
  init(baseURL: URL) { self.baseURL = baseURL }
  func authenticate(token: String?) { self.token = token }
  func request<Value: Decodable>(_ path: String, method: String = "GET", body: Data? = nil, idempotencyKey: String? = nil) async throws -> Value {
    guard let url = URL(string: path, relativeTo: baseURL) else { throw URLError(.badURL) }; var request = URLRequest(url: url); request.httpMethod = method; request.httpBody = body; request.setValue("application/json", forHTTPHeaderField: "Content-Type"); if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }; if let idempotencyKey { request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key") }; let (data, response) = try await URLSession.shared.data(for: request); guard let http = response as? HTTPURLResponse, 200..<300 ~= http.statusCode else { throw URLError(.badServerResponse) }; return try JSONDecoder().decode(APIEnvelope<Value>.self, from: data).data
  }
}
actor OfflineQueue {
  private var mutations: [OfflineMutation] = []
  func enqueue(path: String, method: String, body: Data) { mutations.append(.init(id: UUID(), path: path, method: method, body: body, idempotencyKey: UUID().uuidString.lowercased(), attempts: 0)) }
  func flush(using client: APIClient) async { var pending: [OfflineMutation] = []; for var mutation in mutations { do { let _: EmptyResponse = try await client.request(mutation.path, method: mutation.method, body: mutation.body, idempotencyKey: mutation.idempotencyKey) } catch { mutation.attempts += 1; if mutation.attempts < 5 { pending.append(mutation) } } }; mutations = pending }
  func count() -> Int { mutations.count }
}
struct EmptyResponse: Codable {}
