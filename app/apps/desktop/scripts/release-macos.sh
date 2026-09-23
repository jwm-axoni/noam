#!/usr/bin/env bash
# Build the notarized macOS installer and signed updater archive.
# Keep Apple credentials in .env.release/keychain and the updater key outside Git.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f .env.release ]; then set -a; . ./.env.release; set +a; fi

: "${APPLE_TEAM_ID:?set APPLE_TEAM_ID}"
: "${APPLE_SIGNING_IDENTITY:?set APPLE_SIGNING_IDENTITY}"
: "${NOTARY_PROFILE:?set NOTARY_PROFILE}"
: "${RELEASE_NOTES_FILE:?set RELEASE_NOTES_FILE}"

updater_key="${NOAM_UPDATER_KEY_PATH:-$HOME/.config/noam/release/updater-v1.key}"
[ -f "$updater_key" ] || { echo "Missing updater signing key" >&2; exit 1; }
[ -f "$RELEASE_NOTES_FILE" ] || { echo "Missing release notes file" >&2; exit 1; }
security find-identity -v -p codesigning | grep -qF "$APPLE_SIGNING_IDENTITY" || {
  echo "Apple signing identity is unavailable" >&2; exit 1;
}
xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1 || {
  echo "Apple notarization profile is unavailable" >&2; exit 1;
}
export TAURI_SIGNING_PRIVATE_KEY="$updater_key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(security find-generic-password -a noam-release -s noam-updater-v1-passphrase -w)"
[ -n "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" ] || { echo "Missing updater key password" >&2; exit 1; }

version="$(node -p 'require("./package.json").version')"
[ "$version" = "$(node -p 'require("./src-tauri/tauri.conf.json").version')" ] || {
  echo "Desktop and Tauri versions differ" >&2; exit 1;
}

pnpm tauri build --bundles app
app="src-tauri/target/release/bundle/macos/Noam.app"
dmg="src-tauri/target/release/bundle/dmg/Noam_${version}_aarch64.dmg"
latest_dmg="src-tauri/target/release/bundle/dmg/Noam_aarch64.dmg"
archive="src-tauri/target/release/bundle/macos/Noam.app.tar.gz"
[ -d "$app" ] && [ -f "$archive" ] || {
  echo "Expected app or updater archive is missing" >&2; exit 1;
}
codesign --verify --deep --strict "$app"

# Notarize and staple before packaging either download. The archive Tauri built
# precedes stapling, so replace it with an archive of the final app and re-sign.
release_tmp="$(mktemp -d)"
trap 'rm -rf "$release_tmp"' EXIT
notary_zip="$release_tmp/Noam-notary.zip"
ditto -c -k --keepParent "$app" "$notary_zip"
xcrun notarytool submit "$notary_zip" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$app"
xcrun stapler validate "$app"
spctl --assess --type execute "$app"
tar -czf "$archive" -C "$(dirname "$app")" "$(basename "$app")"
unset TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PATH="$updater_key" pnpm tauri signer sign "$archive"

mkdir -p "$(dirname "$dmg")" "$release_tmp/image"
ditto "$app" "$release_tmp/image/Noam.app"
ln -s /Applications "$release_tmp/image/Applications"
hdiutil create -volname Noam -srcfolder "$release_tmp/image" -ov -format UDZO "$dmg"
codesign --sign "$APPLE_SIGNING_IDENTITY" --timestamp "$dmg"
xcrun notarytool submit "$dmg" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
cp -p "$dmg" "$latest_dmg"

node scripts/create-update-manifest.mjs "$version" "$archive" "$archive.sig" "$RELEASE_NOTES_FILE" \
  src-tauri/target/release/bundle/macos/latest.json
printf 'Release assets ready:\n%s\n%s\n%s\n%s\n%s\n' \
  "$dmg" "$latest_dmg" "$archive" "$archive.sig" src-tauri/target/release/bundle/macos/latest.json
