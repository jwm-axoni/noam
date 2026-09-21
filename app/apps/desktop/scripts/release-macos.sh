#!/usr/bin/env bash
#
# Build, sign, notarize and staple a Developer ID macOS release of Noam.
#
# Reads ALL signing and notarization material from the environment (or a
# gitignored .env.release beside this app). Commits no secrets. See
# docs/RELEASE.md. Nothing here runs until the two prerequisites exist:
#
#   1. A "Developer ID Application" certificate installed in the login
#      keychain (create it in the Apple Developer account, install the .cer
#      together with its private key).
#   2. A notarytool credential, stored once as a keychain profile:
#        xcrun notarytool store-credentials "$NOTARY_PROFILE" \
#          --apple-id <apple-id> --team-id <TEAM_ID> \
#          --password <app-specific-password>
#      (or an App Store Connect API key via --key/--key-id/--issuer.)
#
# Required variables (put them in a gitignored .env.release, or export them):
#   APPLE_TEAM_ID          10-char Team ID
#   APPLE_SIGNING_IDENTITY full identity, e.g.
#                          "Developer ID Application: Your Name (TEAMID)"
#   NOTARY_PROFILE         name of the stored notarytool keychain profile
#
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # app/apps/desktop

if [ -f .env.release ]; then set -a; . ./.env.release; set +a; fi

: "${APPLE_TEAM_ID:?set APPLE_TEAM_ID (10-char Team ID)}"
: "${APPLE_SIGNING_IDENTITY:?set APPLE_SIGNING_IDENTITY (\"Developer ID Application: Name (TEAMID)\")}"
: "${NOTARY_PROFILE:?set NOTARY_PROFILE (a stored notarytool keychain profile)}"

echo "==> Preflight"
if ! security find-identity -v -p codesigning | grep -qF "$APPLE_SIGNING_IDENTITY"; then
  echo "error: signing identity not in keychain: $APPLE_SIGNING_IDENTITY" >&2
  echo "       Install a 'Developer ID Application' certificate first." >&2
  security find-identity -v -p codesigning >&2
  exit 1
fi
if ! xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
  echo "error: notarytool profile not usable: $NOTARY_PROFILE" >&2
  echo "       Create it with: xcrun notarytool store-credentials $NOTARY_PROFILE ..." >&2
  exit 1
fi

echo "==> Building (Tauri signs the .app and .dmg with the identity)"
export APPLE_SIGNING_IDENTITY APPLE_TEAM_ID
pnpm tauri build

dmg=$(ls -t src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null | head -1)
app=$(ls -td src-tauri/target/release/bundle/macos/*.app 2>/dev/null | head -1)
[ -n "$dmg" ] || { echo "error: no .dmg produced under target/release/bundle/dmg" >&2; exit 1; }

echo "==> Notarizing $dmg"
xcrun notarytool submit "$dmg" --keychain-profile "$NOTARY_PROFILE" --wait

echo "==> Stapling and verifying"
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
[ -n "$app" ] && codesign --verify --deep --strict --verbose=2 "$app"
spctl -a -vvv -t install "$dmg" || echo "(note: spctl assessment above)"

echo "==> Done: $dmg"
