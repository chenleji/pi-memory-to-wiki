# Security Policy

`pi-memory-to-wiki` reads durable memory and can precisely remove reviewed
Hermes copies after Wiki verification. Treat unsafe cleanup, path escape,
verification bypass, candidate forgery, and audit-ledger corruption as security
issues.

## Supported versions

Until a stable release exists, only the latest commit on `main` is supported.
Compatibility is currently tested with Pi 0.84.x, Node.js 24,
`pi-hermes-memory 0.9.4`, and `@zosmaai/pi-llm-wiki 0.11.4`.

## Reporting a vulnerability

Do not open a public issue containing exploit details or private memory data.
Use GitHub's private vulnerability reporting for this repository:

https://github.com/chenleji/pi-memory-to-wiki/security/advisories/new

Include:

- affected commit or version;
- Pi, Node.js, Hermes Memory, and LLM Wiki versions;
- minimal reproduction using synthetic data;
- expected and actual behavior;
- whether any data was deleted, disclosed, or written unexpectedly.

Never include real `MEMORY.md`, `USER.md`, `failures.md`, `sessions.db`, Wiki
pages, ledger files, tokens, or credentials.

## Security invariants

A valid release must preserve all of the following:

- Scan is read-only.
- First finalize rescans and uses an authoritative candidate.
- Candidate IDs, fingerprints, storage classes, and backing-copy paths are
  validated server-side.
- Paths cannot escape configured Hermes storage roots.
- Storage Contract incompatibility fails closed.
- Cleanup intent is persisted before deletion.
- Changed or unexpected copies abort cleanup.
- Retry never expands the original deletion set.
- `USER.md` and standing instructions are never candidates.
- Wiki private files and indexes are never modified directly.

## Operational precautions

Keep backups of important memory and Wiki data. Review every proposed deletion.
If you see `CANDIDATE_CHANGED` or `STORAGE_CONTRACT_UNSUPPORTED`, rescan or stop;
do not manually bypass the guard.
