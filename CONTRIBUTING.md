# Contributing

Thanks for helping improve `pi-memory-to-wiki`.

## Before opening an issue

- Search existing issues first.
- Include Pi, Node.js, `pi-hermes-memory`, and `pi-llm-wiki` versions.
- Include the stable error code and sanitized error message.
- Never attach `MEMORY.md`, `USER.md`, `failures.md`, `sessions.db`, the
  promotion ledger, access tokens, or private Wiki pages.

Security vulnerabilities and unsafe deletion scenarios belong in the private
process described by [SECURITY.md](SECURITY.md), not a public issue.

## Development setup

```bash
git clone https://github.com/chenleji/pi-memory-to-wiki.git
cd pi-memory-to-wiki
npm ci
npm run validate
```

Node.js 24 or newer is required.

## Design boundaries

Changes should preserve these boundaries:

- `memory_to_wiki_scan` remains read-only and does not create the ledger.
- Wiki access uses public Wiki tools; do not import Wiki private modules or edit
  its vault indexes directly.
- Hermes private storage knowledge stays inside `src/hermes-adapter.ts`.
- No Hermes deletion occurs without user approval and post-write Wiki recall
  evidence.
- Cleanup is compare-and-delete: exact candidate identity, fingerprint, path,
  row/entry identity, and current hash must match.
- Cleanup intent is durable before deletion and retries are idempotent.
- `USER.md` and standing instructions remain excluded.

## Tests

Tests are written at the two public seams:

- `memory_to_wiki_scan`
- `memory_to_wiki_finalize`

Use temporary fixtures only. Never point automated tests at live Pi memory or a
real Wiki. Add a regression test before fixing safety, recovery, storage
compatibility, or cursor bugs.

Before submitting:

```bash
npm run validate
npm audit --audit-level=high
```

## Pull requests

Keep changes focused and explain:

- the user-visible behavior;
- storage or compatibility assumptions;
- failure and rollback behavior;
- tests added;
- whether the change can expand the deletion set.

Breaking Storage Contract changes should update README compatibility notes and
`CHANGELOG.md`.
