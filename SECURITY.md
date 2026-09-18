# Security Policy

Noam handles authentication, per-file access control, and real-time
sync, so we take security reports seriously. Thank you for helping keep
users safe.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub
issues, discussions, or pull requests.**

Use GitHub Private Vulnerability Reporting: open the repository's **Security**
tab and choose **Report a vulnerability**. If that option is unavailable, use
the private contact method published on the repository owner's GitHub profile.
Do not include vulnerability details in a public issue or discussion.

Please include, as far as you can:

- A description of the issue and its impact.
- Steps to reproduce (proof-of-concept if possible).
- Affected component (desktop app, sync server, MCP endpoint, auth, etc.)
  and version / commit.
- Any suggested remediation.

## What to expect

- We aim to **acknowledge** your report within **3 business days**.
- We'll work with you on a fix and coordinate a disclosure timeline.
- With your permission, we're happy to **credit** you once a fix ships.

Please give us reasonable time to remediate before any public disclosure.

## Scope

Areas of particular interest:

- Authentication and session handling (Better Auth, argon2id, bearer tokens).
- Per-file / per-folder permission resolution and the sync-token ACL gate.
- The MCP endpoint and token scoping.
- Path-safety in the Rust core (`resolve_in_vault`, attachments).
- Sanitization of rendered HTML / live-preview.

## Supported versions

Noam is pre-1.0. Security fixes target the latest `main`. Pin to a
released tag for production and update promptly when fixes are published.
