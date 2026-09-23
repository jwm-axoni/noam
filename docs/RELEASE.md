# Releasing Noam

Noam ships through the manual-only `Release` GitHub Actions workflow
(`.github/workflows/release.yml`). A human dispatches it, an approver releases
the protected `release` environment, the workflow builds, signs, notarizes and
uploads a **draft** GitHub Release, and a human reviews and publishes that draft.
Publishing is what makes the update visible to installed apps: the desktop
updater polls the `latest.json` manifest attached to the latest published
release and verifies every artifact against the updater public key committed in
`app/apps/desktop/src-tauri/tauri.conf.json`.

macOS is distributed as a Developer ID-signed and notarized download. Mac App
Store distribution is a separate project because it requires App Sandbox and
persistent access through security-scoped bookmarks.

## Rules

- Never commit Apple credentials, legal names, Apple Account email addresses,
  Team IDs, certificate names, provisioning profiles, or private keys.
- Keep signing material in the macOS keychain or protected release secrets. The
  updater private key exists only as a GitHub environment secret and in an
  offline backup; only its public key is in the repository.
- Do not publish from a working directory that contains the old repository's
  Git history.
- Never rotate the updater key casually: apps in the field verify against the
  committed public key, and a release signed with a different key is rejected
  by every installed copy. A rotation needs one transitional release that still
  verifies under the old key and carries the new public key.
- A successful build is not release proof. Verify the signature, notarization
  ticket, clean installation, launch, vault selection, microphone prompt, and
  update behavior separately.

## Version

Before a release, keep these values equal (the workflow refuses to build when
they differ):

- `app/apps/desktop/package.json`
- `app/apps/desktop/src-tauri/tauri.conf.json`
- `app/apps/desktop/src-tauri/Cargo.toml`
- the `desktop` package entry in `Cargo.lock`

The workflow reads the version from `tauri.conf.json`, tags the release
`v<version>` and names it `Noam v<version>`. The tag is created when the draft
is published, so a re-run of a failed release for the same version needs the
draft deleted first.

## Local release gate

From the repository root, before dispatching:

```bash
corepack enable
pnpm --dir app install --frozen-lockfile
pnpm --dir app check:publication
pnpm --dir app test
cargo test --manifest-path app/apps/desktop/src-tauri/Cargo.toml
```

The workflow re-runs the publication guards (`publication-readiness` job:
repository guard tests, the tree and history scans, and a gitleaks secret scan)
before the signing job starts, so a tree that would fail the guardrails cannot
ship.

## One-time repository setup

The signing job runs in a GitHub **environment named `release`**. Create it in
the repository settings (Settings → Environments → New environment) and add a
**required reviewer**; every dispatch then pauses at the signing job until an
approver releases it. Store the secrets below as environment secrets on
`release` (repository secrets also work, but the environment keeps them out of
every other workflow).

| Secret | Purpose |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Updater private key (minisign format), root of trust for auto-update |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password the key was generated with |
| `APPLE_CERTIFICATE` | Developer ID Application certificate, `.p12` base64-encoded |
| `APPLE_CERTIFICATE_PASSWORD` | Password of that `.p12` |
| `APPLE_SIGNING_IDENTITY` | The certificate's common name, e.g. `Developer ID Application: …` |
| `APPLE_ID` | Apple Account used for notarization |
| `APPLE_PASSWORD` | App-specific password for that account |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

`GITHUB_TOKEN` is provided by Actions; the workflow needs `contents: write`
(already declared) to create the draft and upload assets.

To generate the updater key pair, from `app/`, writing the key outside the
repository:

```bash
pnpm --filter desktop tauri signer generate -w ~/.tauri/noam.key
```

Back up the private key in a protected secret store, store it and its password
as the two `TAURI_SIGNING_*` secrets, and commit only the public key as
`plugins.updater.pubkey` in `tauri.conf.json`.

## Apple setup

The Apple Developer membership is an individual account. Apple may display the
account holder's legal name as the seller or developer name; that is expected.
Keep that identity in Apple Developer and App Store Connect rather than copying
it into source files, package metadata, sample data, or public documentation.

Create a Developer ID Application certificate in the Apple Developer account,
export it as a password-protected `.p12`, and base64-encode it for the
`APPLE_CERTIFICATE` secret. Use an app-specific password for notarization.
Supply credentials only through secrets or the local keychain. Do not write
their values into documentation or configuration files.

The committed configuration uses ad-hoc signing for development. The release
workflow overrides it with `APPLE_SIGNING_IDENTITY`.

For a later Mac App Store submission, treat these as separate release gates:

- enable App Sandbox and replace persistent raw folder access with
  security-scoped bookmarks;
- provide final support and privacy-policy URLs in App Store Connect;
- complete the app privacy answers from the shipped behavior, including sync,
  account, billing, and microphone data paths;
- keep the existing microphone purpose string accurate;
- give App Review a synthetic test vault and clear steps for offline and sync
  flows without exposing personal data.

## Cut a release

1. Land the version bump on `development` (all four version values equal) and
   pass the local release gate above.
2. Open Actions → **Release** → **Run workflow**, choose the branch, run it.
3. Wait for `publication-readiness` to pass; the `build-macos` job then waits
   for a `release` environment approval. Review the commit being released and
   approve.
4. The job builds, signs, notarizes and uploads a **draft** release named
   `Noam v<version>` with the `.dmg`, the `.app.tar.gz`, its `.sig`, and
   `latest.json`.
5. Download the `.dmg` from the draft and run the artifact verification below
   on a separate macOS account or machine.
6. Review the draft's assets and notes, then **Publish release**. Do not mark
   it a pre-release: the updater's `releases/latest` endpoint ignores
   pre-releases, so a pre-release never reaches installed apps.

Publishing is the point of no return for auto-update. Until then the draft can
be deleted and the workflow re-run.

## Verify the artifact

Run these commands against the built application or disk image before
publishing:

```bash
codesign --verify --deep --strict --verbose=2 <path-to-app>
spctl --assess --type execute --verbose=2 <path-to-app>
xcrun stapler validate <path-to-app-or-dmg>
```

Then, on a separate macOS account or machine:

1. Gatekeeper opens it without a bypass.
2. The app launches and displays the released version in Settings → Updates.
3. The native folder picker opens a synthetic vault outside the repository.
4. The app retains access after restart.
5. Push-to-talk shows the expected microphone permission text and releases the
   microphone when the button is released.
6. No build path, account name, email address, or signing secret appears in the
   bundle, logs, crash metadata, or About window.
7. From an install of the *previous* published version, Settings → Updates →
   **Check for updates** offers the new version, and **Install & Restart**
   relaunches into it. This is the only test of the signing chain end to end.

## Auto-update

The desktop app registers the Tauri updater whenever `tauri.conf.json` carries
`plugins.updater` (public key + endpoint); a source build without that block
starts without it. The endpoint is the `latest.json` of the latest published
GitHub Release. Only the `.app.tar.gz` + `.sig` pair is used for updates; the
`.dmg` is the first-install download.

Two controls sit on top of that:

- **Per-user toggle** — Settings → Updates → "Automatically check for updates"
  (`auto_check_updates` in the app's `config.json`, default on). Off means no
  launch or polling checks; the manual "Check for updates" button still works.
- **Managed policy** — an IT override the user cannot bypass. The app only ever
  reads it, in this order:
  1. the environment variable `NOAM_UPDATER_POLICY=disabled` (off + locked);
  2. a `managed-policy.json` in a **system-owned** location, shaped
     `{ "autoUpdate": { "enabled": false, "locked": true } }`:

     | Platform | Path |
     | --- | --- |
     | macOS | `/Library/Application Support/com.noam.app/managed-policy.json` |
     | Linux | `/etc/noam/managed-policy.json` |
     | Windows | `%ProgramData%\Noam\managed-policy.json` |

  `locked` disables the toggle and makes the stored user preference irrelevant
  in both directions (`enabled: true, locked: true` forces checks on even for a
  user who opted out). `enabled: false, locked: true` is the strongest state:
  the updater plugin is not registered at all, so there is no polling and no
  update wall, and the Updates tab disables the manual controls. The file
  deliberately does not live in the user's own config directory, because the
  user owns that directory and could remove it.

## Local script release

Noam 0.1.59 is the last download without update support. Version 0.1.60 and
later check the signed `latest.json` manifest at launch and while open and show
**Install & Restart** when a newer version exists; the app never restarts during
editing without a click. People on 0.1.59 must download the new app once from
the Releases page.

0.1.60 was published with `app/apps/desktop/scripts/release-macos.sh`, which
builds, signs, notarizes and staples the DMG and updater archive from a local
machine instead of the `Release` workflow. It reads the updater private key
from `NOAM_UPDATER_KEY_PATH` (default `~/.config/noam/release/updater-v1.key`)
and its password from the macOS Keychain (`noam-release` account,
`noam-updater-v1-passphrase` service); that key must be the one whose public
half is committed as `plugins.updater.pubkey`, or every installed copy rejects
the release. Put `APPLE_TEAM_ID`, `APPLE_SIGNING_IDENTITY`, and
`NOTARY_PROFILE` in the local, ignored `app/apps/desktop/.env.release`, write
a plain-text release notes file outside Git and run from `app/apps/desktop`:

```bash
RELEASE_NOTES_FILE=/path/to/notes.txt bash scripts/release-macos.sh
```

The script writes `latest.json` (`scripts/create-update-manifest.mjs`) with
the archive URL and signature. Publish these five files together under the
matching `vX.Y.Z` tag:

- `Noam_X.Y.Z_aarch64.dmg`
- `Noam_aarch64.dmg` (the same signed download under a stable name for the
  README and website, so a new release becomes the current download without
  editing a version-specific URL)
- `Noam.app.tar.gz`
- `Noam.app.tar.gz.sig`
- `latest.json`

Before announcing, verify the uploaded DMG's checksum and Gatekeeper result,
install it on a clean account, open a synthetic vault, and confirm the
`latest.json` asset and archive URL respond over HTTPS. The first
updater-enabled version cannot be tested against 0.1.59, which never checks
for updates.
