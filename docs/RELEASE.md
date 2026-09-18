# Releasing Noam

Noam has no active release workflow and no published binary release. The
desktop updater is disabled until the neutral repository, release URL, and new
updater signing key are ready.

The first macOS release will be distributed directly as a Developer ID-signed
and notarized download. Mac App Store distribution is a separate project
because it requires App Sandbox and persistent access through security-scoped
bookmarks.

## Rules

- Never commit Apple credentials, legal names, Apple Account email addresses,
  Team IDs, certificate names, provisioning profiles, or private keys.
- Keep signing material in the macOS keychain or protected release secrets.
- Do not publish from a working directory that contains the old repository's
  Git history.
- Do not enable auto-update until a fresh updater key and final HTTPS endpoint
  are configured and tested.
- A successful build is not release proof. Verify the signature, notarization
  ticket, clean installation, launch, vault selection, microphone prompt, and
  update behavior separately.

## Version

Before a release, keep these values equal:

- `app/apps/desktop/package.json`
- `app/apps/desktop/src-tauri/tauri.conf.json`
- `app/apps/desktop/src-tauri/Cargo.toml`
- the `desktop` package entry in `Cargo.lock`

Noam starts at `0.1.0` in the clean repository.

## Local release gate

From the repository root:

```bash
corepack enable
pnpm --dir app install --frozen-lockfile
pnpm --dir app check:publication
pnpm --dir app test
cargo test --manifest-path app/apps/desktop/src-tauri/Cargo.toml
```

The complete publication check must also pass inside the clean export after its
single root commit is created:

```bash
node scripts/check-publication.mjs --scope all
```

## Apple setup

The Apple Developer membership is an individual account. Apple may display the
account holder's legal name as the seller or developer name; that is expected.
Keep that identity in Apple Developer and App Store Connect rather than copying
it into source files, package metadata, sample data, or public documentation.

Create a Developer ID Application certificate in the Apple Developer account
and install it in the signing keychain. Use either App Store Connect API
credentials or an app-specific password for notarization. Supply credentials
through the environment or keychain at build time. Do not write their values
into documentation or configuration files.

The committed configuration uses ad-hoc signing for development. Override it
for a release build with `APPLE_SIGNING_IDENTITY`.

For a later Mac App Store submission, treat these as separate release gates:

- enable App Sandbox and replace persistent raw folder access with
  security-scoped bookmarks;
- provide final support and privacy-policy URLs in App Store Connect;
- complete the app privacy answers from the shipped behavior, including sync,
  account, billing, and microphone data paths;
- keep the existing microphone purpose string accurate;
- give App Review a synthetic test vault and clear steps for offline and sync
  flows without exposing personal data.

## Build the macOS installer

From `app/` on a Mac with the signing identity available:

```bash
pnpm --filter desktop tauri build --bundles dmg
```

Tauri signs the application, submits it to Apple's notary service when valid
notarization credentials are present, and staples the returned ticket. Treat a
build without all three results as an internal test build.

## Verify the artifact

Run these commands against the built application or disk image before upload:

```bash
codesign --verify --deep --strict --verbose=2 <path-to-app>
spctl --assess --type execute --verbose=2 <path-to-app>
xcrun stapler validate <path-to-app-or-dmg>
```

Then download the uploaded artifact on a separate macOS account or machine and
verify:

1. Gatekeeper opens it without a bypass.
2. The app launches and displays version `0.1.0`.
3. The native folder picker opens a synthetic vault outside the repository.
4. The app retains access after restart.
5. Push-to-talk shows the expected microphone permission text and releases the
   microphone when the button is released.
6. No build path, account name, email address, or signing secret appears in the
   bundle, logs, crash metadata, or About window.

## Auto-update

Auto-update is intentionally off. Before enabling it:

1. Generate a new Tauri updater key outside the repository.
2. Back up the private key in a protected secret store.
3. Commit only the public key.
4. Configure the final neutral HTTPS release endpoint.
5. Publish a signed test update and verify installation from an older build.
6. Add release automation only after the local process has passed end to end.

Any future workflow should start as manual-only and must run the complete
publication gate before it creates a release.
