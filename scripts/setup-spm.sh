#!/bin/sh
# Re-clones capacitor-swift-pm locally — run this after a fresh git clone
# or when updating the Capacitor version.
# Bypasses the Xcode 15.3+/16 xcodebuild bare-repo safe.bareRepository bug.

set -e

CAP_VERSION=$(node -e "const p=require('./package.json'); const v=p.dependencies['@capacitor/core']; console.log(v.replace(/[\^~]/,''))")
echo "→ Capacitor core version: $CAP_VERSION"

DEST=".capacitor-spm/capacitor-swift-pm"

rm -rf "$DEST"
git clone --depth 1 --branch "$CAP_VERSION" \
  https://github.com/ionic-team/capacitor-swift-pm.git \
  "$DEST"

echo "✓ capacitor-swift-pm@$CAP_VERSION cloned to $DEST"
