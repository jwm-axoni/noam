# Contributing to Noam

Thanks for your interest in improving Noam. Bug reports and focused design
discussions are welcome.

## Contribution status

No public license or contribution agreement has been selected. Do not submit
code or documentation unless the maintainers requested it and agreed to the
terms first. Unsolicited pull requests may be closed without review.

## Before you start a large change

For anything beyond a small fix, **open an issue first** so we can align on
approach. Noam has a deliberate architecture (see below) and some
invariants are load-bearing. A quick discussion saves rework.

## Understanding the codebase

Read these before diving in:

- `CLAUDE.md`: the architectural overview and the invariants that matter.
- `docs/Noam.md`: the docs index.
- `docs/specs/`: the design specs (source of truth).
- `docs/STATUS.md`: current build state.

Key invariants you must not break (details in `CLAUDE.md`):

- **Identity is `doc_id`, never a path.** Never resolve or store a note by path across layers.
- **The server stores binary Y.Doc only.** Markdown never travels the wire.
- **`.context/` is hidden and sacred.** Never walk, sync, or index it.
- **Debounce timings are load-bearing** (watcher/ingest ~150ms, egest ~300ms).

## Development setup

Prerequisites: Node ≥ 22, Rust/Cargo, Docker. From `app/`, run `pnpm install` once.

**Server** (from `app/apps/server/`):

```bash
cp .env.example .env      # change JWT_SECRET for anything real
pnpm run db:up             # Postgres 16 in Docker (host port 5439)
pnpm run migrate           # apply migrations
pnpm run dev               # HTTP :3010, sync WS :3011
```

**Desktop** (from `app/`): `pnpm run dev:desktop`

## Tests must pass

Run the relevant suites before opening a PR:

- Everything: `pnpm test` from `app/`.
- Server (`app/apps/server`): `pnpm test` (needs `db:up` + `migrate` first).
  ⚠️ This **wipes the dev DB**, so re-seed afterward.
- Desktop TS (`app/apps/desktop`): `pnpm test`. The bridge suites (`echo`,
  `concurrent`, `rewrite`, `roundtrip`) gate correctness of the whole product.
- Desktop Rust: `cargo test` in `src-tauri/`.

## Repository publication guards

Run `pnpm run setup:guards` from `app/` after cloning. `pnpm install` also runs
this setup automatically. The local hooks then check the exact staged snapshot
before every commit and the complete outgoing commit range before every push.

The push guard only permits this repository's approved GitHub destination and
requires every outgoing branch to descend from the clean public root commit.
It also runs both the publication policy and gitleaks over history, so adding a
private value and deleting it in a later commit still blocks the push.

Git hooks can be skipped locally, so GitHub repeats the full checks in the
required `publication-readiness` workflow. Do not merge while that check is
missing or failing.

## Pull request checklist

- [ ] Discussed non-trivial changes in an issue first.
- [ ] Tests pass locally; new behavior has tests.
- [ ] No secrets, credentials, or `.env` files committed.
- [ ] The `publication-readiness` check passes.
- [ ] Followed the existing code style of the files you touched.

## Reporting security issues

**Do not** open a public issue for vulnerabilities. See [SECURITY.md](SECURITY.md).

## Code of conduct

This project follows our [Code of Conduct](CODE_OF_CONDUCT.md). By
participating, you agree to uphold it.
