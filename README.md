# pi-memory-to-wiki

[![CI](https://github.com/chenleji/pi-memory-to-wiki/actions/workflows/ci.yml/badge.svg)](https://github.com/chenleji/pi-memory-to-wiki/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-339933)](https://nodejs.org/)

A human-reviewed promotion gate from
[`pi-hermes-memory`](https://github.com/chandra447/pi-hermes-memory) to
[`pi-llm-wiki`](https://github.com/zosmaai/pi-llm-wiki).

It turns working memory into formal Wiki knowledge through an explicit review,
verification, cleanup, and audit workflow. It is deliberately **not** another
memory system and never imports or modifies LLM Wiki's private implementation.

> [!WARNING]
> An approved promotion can delete the exact matching Hermes Memory copies after
> Wiki recall verification succeeds. Review the preview carefully and keep a
> backup of important memory data. `USER.md` and standing instructions are never
> eligible for promotion or deletion.

## Why this exists

Hermes Memory is optimized for low-friction continuity: it may contain working
notes, corrections, failures, conventions, and not-yet-curated facts. LLM Wiki
is optimized for structured, searchable, source-aware knowledge. Running both
creates useful temporary overlap, but moving knowledge between them needs a
controlled boundary.

`pi-memory-to-wiki` provides that boundary:

1. Discover eligible Hermes Memory candidates.
2. Compare each candidate with Wiki semantic recall and exact search.
3. Ask the user to approve, reject, defer, or resolve conflicts.
4. Use LLM Wiki's public tools to write or confirm knowledge.
5. Recall the knowledge again as verification evidence.
6. Persist a cleanup intent, then precisely remove unchanged Hermes copies.
7. Record the decision and cleanup result in an auditable ledger.

## Requirements

- Node.js 24 or newer.
- Pi coding agent 0.84.x or compatible.
- [`pi-hermes-memory`](https://github.com/chandra447/pi-hermes-memory), tested
  with `0.9.4`.
- [`@zosmaai/pi-llm-wiki`](https://github.com/zosmaai/pi-llm-wiki), tested with
  `0.11.4`.
- A Git client for GitHub installation.

## Install

Install the two systems first if they are not already present:

```bash
pi install npm:pi-hermes-memory
pi install npm:@zosmaai/pi-llm-wiki
```

Then install this public GitHub package:

```bash
pi install git:github.com/chenleji/pi-memory-to-wiki
```

Restart Pi or run `/reload` if the current interactive session was already open.

> `pi-memory-to-wiki` is not currently published to npm. The GitHub install
> command above is the supported installation method.

### Update

```bash
pi update git:github.com/chenleji/pi-memory-to-wiki
```

### Remove

```bash
pi remove git:github.com/chenleji/pi-memory-to-wiki
```

Removing the extension does not delete its audit ledger. The ledger remains at
`~/.pi/agent/pi-memory-to-wiki/promotion-ledger.sqlite` unless you deliberately
archive or remove it.

## Quick start

From a Git project:

```text
/memory-to-wiki
```

Useful variants:

```text
/memory-to-wiki --scope global --since 30d --limit 50
/memory-to-wiki --scope project --since 2026-08-01 --limit 20
/memory-to-wiki --cursor <token>
```

Defaults are current project, the last 7 days, and 20 candidates. If the current
directory is not inside a Git repository, project scope falls back to global
and reports the fallback.

The command performs only orchestration. It scans, compares candidates through
`wiki_recall` and `wiki_search`, shows the proposed action and deletion impact,
and waits for user approval before any Wiki mutation or Hermes cleanup.

## Candidate actions

- **New** — write new formal knowledge through Wiki's public tools.
- **Supplement** — merge missing information into an existing Wiki page first.
- **Existing** — do not duplicate the Wiki content; verification can still mark
  the promotion complete and clean Hermes.
- **Conflict** — stop by default. The user must choose Wiki wins, Hermes wins, or
  defer.
- **Skip** — leave both systems unchanged.

Atomic insights should normally use `wiki_retro`. Source-rich or deeply
synthesized material should use `wiki_capture_source` followed by `wiki_ingest`.
Direct documents, URLs, and pasted text should continue to enter Wiki directly;
they do not need to pass through Hermes Memory.

## Safety model

### Read-only scan

`memory_to_wiki_scan`:

- reads Core Markdown and Extended SQLite current memory;
- folds exact storage mirrors into one logical candidate;
- excludes `USER.md` and standing instructions;
- returns stable candidate identities, fingerprints, backing-copy descriptors,
  and keyset cursors;
- filters candidates already promoted or rejected;
- does not write Wiki, Hermes, or the promotion ledger.

### Verified finalize

`memory_to_wiki_finalize`:

- requires post-write Wiki recall evidence bound to the same `candidate_id`;
- rescans Hermes on the first finalize call and replaces caller-supplied copy
  descriptors with the authoritative candidate;
- restricts Markdown and SQLite paths to configured Hermes storage roots;
- recomputes identity and fingerprint before cleanup;
- persists cleanup intent before deletion;
- uses the upstream-compatible canonical Markdown lock protocol;
- validates the SQLite Storage Contract and exact row/entry hashes;
- returns `cleanup_pending` on a recoverable partial failure;
- safely resumes a persisted cleanup after process interruption.

The state machine uses one key per candidate fingerprint. `promoted` and
`rejected` are terminal; `deferred` can later transition to approval or
rejection; an approved `cleanup_pending` operation cannot reverse its decision.

## Tool contracts

### `memory_to_wiki_scan`

Input:

- `scope`: `project` or `global`.
- `since`: relative duration such as `7d`, `24h`, `2w`, or an ISO date.
- `limit`: 1–100, default 20.
- `cursor`: opaque continuation token returned by the previous scan.
- `include_categories`: optional category filter.

Each candidate includes content and summary, scope, target/category, dates,
storage classes, exact backing copies, logical identity, scan fingerprint, and
eligibility.

### `memory_to_wiki_finalize`

Input includes the complete scanned candidate, `approve|reject|defer`, optional
Wiki action, and mandatory post-write verification for approvals.

Stable error codes include:

- `INVALID_ARGUMENT`
- `INVALID_CURSOR`
- `VERIFICATION_REQUIRED`
- `CANDIDATE_CHANGED`
- `CANDIDATE_NOT_FOUND`
- `STORAGE_CONTRACT_UNSUPPORTED`
- `CLEANUP_FAILED`
- `INTERNAL_ERROR`

## Storage and privacy

The audit ledger is stored locally:

```text
~/.pi/agent/pi-memory-to-wiki/promotion-ledger.sqlite
```

It records candidate identity/fingerprint, decision, Wiki verification evidence,
cleanup intent/result, stable errors, and append-only audit events. New ledger
files are created with mode `0600`.

Memory content is sent to the model and the configured Wiki tools as part of the
review workflow. Review your Pi provider and Wiki configuration before using the
extension with sensitive information. The extension itself does not transmit
analytics or contact any external service directly.

## Compatibility

Tested integration:

- macOS, Pi `0.84.2`, Node.js 24, `pi-hermes-memory 0.9.4`,
  `@zosmaai/pi-llm-wiki 0.11.4`.
- CI runs on Ubuntu with Node.js 24.

Hermes private storage details are isolated in `src/hermes-adapter.ts`. Cleanup
fails closed with `STORAGE_CONTRACT_UNSUPPORTED` if required columns or FTS
triggers are missing. New upstream Hermes storage versions should be verified
before use.

## Troubleshooting

### `/memory-to-wiki` is not listed

```bash
pi update git:github.com/chenleji/pi-memory-to-wiki
```

Then restart Pi or run `/reload`.

### Project scope falls back to global

Run the command from inside a Git worktree, or explicitly use:

```text
/memory-to-wiki --scope global
```

### `CANDIDATE_CHANGED`

The memory changed after scanning. Run `/memory-to-wiki` again and review the new
fingerprint. The extension intentionally refuses stale cleanup.

### `STORAGE_CONTRACT_UNSUPPORTED`

The installed Hermes Memory layout is not compatible with this release. Do not
manually bypass the check. Open an issue with the Pi and `pi-hermes-memory`
versions plus the error message; do not attach private memory files.

### `cleanup_pending`

The Wiki verification is already recorded, but one or more exact Hermes copies
still need cleanup. Retry finalize through the review flow. The persisted intent
makes retry idempotent.

## Development

```bash
git clone https://github.com/chenleji/pi-memory-to-wiki.git
cd pi-memory-to-wiki
npm ci
npm run validate
```

`validate` runs strict type checking, behavioral tests at the two public tool
seams, a real Pi runtime registration/tool-execution smoke test, and a clean
package-install smoke test. Tests use temporary Hermes fixtures and never mutate
live user memory or Wiki data.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md)
before submitting changes. Security-sensitive findings should follow
[SECURITY.md](SECURITY.md) instead of public issue discussion.

## License

[MIT](LICENSE) © 2026 Leji Chen
