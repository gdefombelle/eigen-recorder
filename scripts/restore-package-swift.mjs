// Restores Package.swift to use local capacitor-swift-pm path after `cap sync` overwrites it.
// cap sync uses the remote github URL for capacitor-swift-pm; this script replaces it
// with the local .capacitor-spm path — while keeping all plugin references intact.
//
// Strategy: read the Package.swift that `cap sync` just wrote, then replace only the
// capacitor-swift-pm remote URL entry with the local path reference.

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dest = join(root, 'ios/App/CapApp-SPM/Package.swift');

let content = readFileSync(dest, 'utf8');

// Replace the remote capacitor-swift-pm URL with the local path.
// cap sync writes:  .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "X.Y.Z"),
// We want:          .package(name: "capacitor-swift-pm", path: "../../../.capacitor-spm/capacitor-swift-pm"),
content = content.replace(
  /\.package\(url:\s*"https:\/\/github\.com\/ionic-team\/capacitor-swift-pm\.git"[^)]*\)/,
  '.package(name: "capacitor-swift-pm", path: "../../../.capacitor-spm/capacitor-swift-pm")'
);

// Also remove the "// DO NOT MODIFY" comment to avoid confusion
content = content.replace(
  /\/\/ DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands\n/,
  '// LOCAL PATH for capacitor-swift-pm — managed by scripts/restore-package-swift.mjs\n// Other dependencies use local node_modules paths (added by cap sync).\n'
);

writeFileSync(dest, content, 'utf8');
console.log('✓ Package.swift restored (local capacitor-swift-pm path, plugins intact)');
