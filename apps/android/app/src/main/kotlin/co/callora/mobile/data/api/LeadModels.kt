package co.callora.mobile.data.api

/** In-memory-only CRM projection for the employee linked to this enrolled device. */
data class AssignedLead(
    val id: String,
    val version: Long,
    val displayName: String,
    val firstName: String,
    val lastName: String?,
    val companyName: String?,
    val phoneNumber: String,
    val email: String?,
    val source: String,
    val statusId: String,
    val statusName: String,
    val statusColor: String,
    val lastContactedAt: String?,
    val nextFollowUpAt: String?,
    val nextFollowUpTitle: String?,
    val overdueFollowUpCount: Int,
    val unreturnedMissedCallCount: Int,
    val createdAt: String,
    val updatedAt: String,
)

data class AssignedLeadSummary(
    val total: Int,
    val notContacted: Int,
    val overdue: Int,
    val unreturnedCalls: Int,
)

data class AssignedLeadPage(
    val items: List<AssignedLead>,
    val summary: AssignedLeadSummary,
    val generatedAt: String,
    val nextCursor: String?,
)
