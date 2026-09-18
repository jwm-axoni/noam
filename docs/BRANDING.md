---
type: policy
product: Noam
status: active
date: 2026-09-18
tags: [branding, identifiers, privacy, policy]
---

# Branding policy

Noam is the product name. `context` is the permanent internal codename used by
storage and protocol identifiers. Keeping those roles separate prevents a
future visual rename from becoming a data migration.

## Product-facing identity

The Noam name may appear in user-visible copy, product documentation, icons,
window titles, installer metadata, and the two brand modules:

- `app/apps/desktop/src/lib/brand.ts`
- `app/apps/server/src/brand.ts`

User-visible strings should import those constants where practical. Repository
URLs and release endpoints must come from the current neutral project location,
not a contributor's account name.

## Durable identifiers

Durable identifiers do not change during a visual rebrand:

- vault metadata directory: `.context/`
- local storage prefix: `context.*`
- database and development container names: `context`
- sync issuer and server name: `context`
- bundle identifier: `com.noam.app`
- staging bundle identifier: `com.noam.app.staging`
- keychain service: `com.noam.app`

The Apple bundle identifiers must be confirmed in the distribution account
before the first signed public build. After that release, changing them would
orphan application data and keychain entries.

## Repository privacy

Source code and ordinary documentation must not contain:

- personal names, private email addresses, or account-specific contact details;
- absolute home-directory paths or machine names;
- credentials, signing identities, Team IDs, provisioning profiles, or keys;
- repository URLs tied to a personal account; or
- real user vault data, screenshots, or local configuration.

Synthetic examples should use reserved domains such as `example.com`,
`example.invalid`, or `.test`, and generic paths such as `/vaults/example`.
Legally required third-party attribution belongs only in `NOTICE` and
`LICENSES/`.

## Release identity

Auto-update remains disabled until the neutral repository exists and a fresh
Tauri updater key has been generated. The private updater key never enters the
repository. The public key and release endpoint may be committed only after the
new location is final.

Before publishing, run the publication-readiness check against the working
tree, the clean export, its Git history, and the new remote metadata.
