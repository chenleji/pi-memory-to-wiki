# pi-memory-to-wiki

`pi-memory-to-wiki` is a human-reviewed promotion gate from
[`pi-hermes-memory`](https://github.com/chandra447/pi-hermes-memory) to LLM Wiki.
It is deliberately **not** another memory system and does not read or modify
LLM Wiki's private files.

## Safety model

- `memory_to_wiki_scan` is read-only. It scans current Core Markdown and
  Extended SQLite memory, folds exact mirrors, filters completed/rejected
  candidates, and returns stable identities, fingerprints and opaque cursors.
- `/memory-to-wiki` injects a fixed Agent workflow that compares every candidate
  through public `wiki_recall` and `wiki_search`, asks for human approval, uses
  the existing Wiki write tools, then performs post-write recall verification.
- `memory_to_wiki_finalize` persists an audit/cleanup intent **before deletion**.
  Approval without successful Wiki recall evidence is rejected. Cleanup uses
  the upstream Markdown lock protocol, an SQLite `BEGIN IMMEDIATE` transaction,
  exact row/entry hashes, and refuses incompatible storage contracts.
- `USER.md` and standing instructions are never scanned or deleted. Direct
  documents, URLs and text continue to use `wiki_capture_source` + `wiki_ingest`.

## Install

```bash
pi install npm:pi-memory-to-wiki
```

For local development:

```bash
pi install /absolute/path/to/pi-memory-to-wiki
```

Requires Node.js 24+ and a compatible `pi-hermes-memory` store (tested against
0.9.4). The extension uses no LLM Wiki implementation imports.

## Usage

```text
/memory-to-wiki
/memory-to-wiki --scope global --since 30d --limit 50
/memory-to-wiki --scope project --since 2026-08-01 --limit 20
/memory-to-wiki --cursor <token>
```

Defaults: current project, 7 days, 20 candidates. If the current directory is
not in a Git project, project scope falls back to global and reports the
fallback.

### Tool contracts

`memory_to_wiki_scan`

- Input: `scope`, optional `since`, `limit`, `cursor`, `include_categories`.
- Output candidates include full content/summary, scope, target/category,
  dates, storage classes, exact backing-copy descriptors, identity,
  fingerprint and eligibility.
- Scan does not create the promotion ledger.

`memory_to_wiki_finalize`

- Input: the complete scanned `candidate`, `approve|reject|defer`, optional Wiki
  action, and mandatory post-write verification bound to the same `candidate_id`
  for approvals. On the first finalize call the extension rescans Hermes and
  replaces caller-supplied copy descriptors with the authoritative candidate;
  only a persisted `cleanup_pending` intent may resume from its ledger snapshot.
- `reject` is audited and suppressed from later scans without deleting memory.
- `defer` is audited but remains discoverable.
- A verified approval becomes `promoted`; cleanup failure becomes
  `cleanup_pending` and can be retried idempotently.

Stable error codes include `INVALID_ARGUMENT`, `INVALID_CURSOR`,
`VERIFICATION_REQUIRED`, `CANDIDATE_CHANGED`,
`STORAGE_CONTRACT_UNSUPPORTED`, `CLEANUP_FAILED`, and `INTERNAL_ERROR`.

## Storage

The audit ledger is stored at:

```text
~/.pi/agent/pi-memory-to-wiki/promotion-ledger.sqlite
```

It records candidate identity/fingerprint, decision, verification evidence,
cleanup intent/result, errors, and an append-only event history. The ledger is
mode `0600` when created.

## Development

```bash
npm install
npm run validate
```

`validate` runs strict type checking, behavioral tests at the two public tool
seams, a real Pi runtime registration smoke test, and a clean package-install
smoke test. All tests use temporary Hermes fixtures and never mutate live user
memory or Wiki data.
