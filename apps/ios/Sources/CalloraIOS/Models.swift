import Foundation
struct APIEnvelope<Value: Decodable>: Decodable { let data: Value }
struct Lead: Codable, Identifiable, Hashable { let id: String; var displayName: String; var phoneNumber: String; var statusName: String; var assignedEmployeeName: String?; var nextFollowUpAt: String? }
struct LeadPage: Codable { let items: [Lead]; let hasMore: Bool }
struct Metric: Codable, Identifiable { let id: String; let label: String; let value: String }
struct Organization: Codable, Identifiable, Hashable { let id: String; let name: String }
struct OfflineMutation: Codable, Identifiable { let id: UUID; let path: String; let method: String; let body: Data; let idempotencyKey: String; var attempts: Int }
enum LoadState<Value> { case idle, loading, loaded(Value), failed(String) }
