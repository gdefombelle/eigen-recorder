#!/bin/sh
# Compiles the shared, UIKit-free PDF code (ios/App/App/ScanPDF.swift) with a macOS test harness and runs it.
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$(mktemp -d)/scanpdf-tests"
swiftc -O -o "$OUT" "$ROOT/ios/App/App/ScanPDF.swift" "$ROOT/scripts/native-tests/scanpdf/main.swift"
"$OUT"
