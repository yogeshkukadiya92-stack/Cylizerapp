// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "CalloraIOS", platforms: [.iOS(.v17), .macOS(.v14)], products: [.executable(name: "CalloraIOS", targets: ["CalloraIOS"])], targets: [.executableTarget(name: "CalloraIOS"), .testTarget(name: "CalloraIOSTests", dependencies: ["CalloraIOS"])])
