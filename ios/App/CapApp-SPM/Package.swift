// swift-tools-version: 5.9
import PackageDescription

// LOCAL PATH — managed by scripts/restore-package-swift.mjs
// cap sync overwrites this; npm run cap:sync restores it automatically.
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(name: "capacitor-swift-pm",
                 path: "../../../.capacitor-spm/capacitor-swift-pm"),
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova",   package: "capacitor-swift-pm")
            ]
        )
    ]
)
