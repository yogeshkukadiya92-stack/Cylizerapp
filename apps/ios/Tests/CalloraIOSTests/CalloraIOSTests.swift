import XCTest; @testable import CalloraIOS
final class CalloraIOSTests: XCTestCase { func testLeadIdentityIsStable() { let lead = Lead(id: "lead-1", displayName: "A", phoneNumber: "+919999999999", statusName: "New", assignedEmployeeName: nil, nextFollowUpAt: nil); XCTAssertEqual(lead.id, "lead-1") } }
