# Releasing Noam for macOS

Noam 0.1.59 is the last download without update support. Version 0.1.60 and later check a signed GitHub release manifest at launch and every 15 minutes. When a newer version exists, the app shows **Install & Restart**; it does not restart during editing without a click. People on 0.1.59 must download 0.1.60 once from the Releases page.

## Release gate

Keep the version equal in `app/apps/desktop/package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and the `desktop` entry in `src-tauri/Cargo.lock`. Release from a clean `main` after the publication check, desktop tests and build, and Rust tests pass. Never commit Apple credentials, signing identities, the updater private key, or its password.

The updater public key and HTTPS endpoint are in `src-tauri/tauri.conf.json`. The encrypted private key stays outside Git at `~/.config/noam/release/updater-v1.key`; its password and a backup copy of the key are stored in the macOS Keychain under the `noam-release` account. Losing that key would prevent future updates for installations that trust it.

## Build and verify

Put `APPLE_TEAM_ID`, `APPLE_SIGNING_IDENTITY`, and `NOTARY_PROFILE` in the local, ignored `app/apps/desktop/.env.release`. Keep the notarytool profile in Keychain. Make a plain-text release notes file outside Git and run from `app/apps/desktop`:

```bash
RELEASE_NOTES_FILE=/path/to/notes.txt bash scripts/release-macos.sh
```

The script builds the DMG and updater archive, verifies code signing, notarizes and staples the app and DMG, then signs the stapled app archive. It writes `latest.json` containing the archive URL and signature. Publish these five files together under the matching `vX.Y.Z` tag:

- `Noam_X.Y.Z_aarch64.dmg`
- `Noam_aarch64.dmg` (the same signed download under a stable name for the website)
- `Noam.app.tar.gz`
- `Noam.app.tar.gz.sig`
- `latest.json`

Before announcing a release, verify the uploaded DMG's checksum and Gatekeeper result, install it on a clean account, and open a synthetic vault. Confirm the `latest.json` asset and archive URL respond over HTTPS. For a subsequent release, update from an older updater-enabled version and verify the signature, install, restart, and preserved vault. The first updater-enabled version cannot be tested against the 0.1.59 release, because that version never checks for updates.

The README and website use GitHub's latest-release asset URL, so a new release becomes the current download without editing a version-specific URL. Publishing remains manual; pushing to `main` alone does not create a downloadable build.
