// Restores Package.swift to use local capacitor-swift-pm path after `cap sync` overwrites it.
// cap sync regenerates Package.swift with remote URL every time — this script fixes it back.

import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const content = `// swift-tools-version: 5.9
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
`;

const dest = join(root, 'ios/App/CapApp-SPM/Package.swift');
writeFileSync(dest, content, 'utf8');
console.log('✓ Package.swift restored to local path reference');
