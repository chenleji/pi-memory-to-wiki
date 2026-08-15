# Changelog

All notable changes to this project will be documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
intends to follow semantic versioning after its first stable release.

## [Unreleased]

## [0.1.0] - 2026-08-15

### Added

- Read-only `memory_to_wiki_scan` across Hermes Core and Extended Memory.
- Stable candidate identities, scan fingerprints, mirror folding, category and
  time filters, and keyset cursors.
- Human-reviewed `/memory-to-wiki` orchestration through public LLM Wiki tools.
- Idempotent `memory_to_wiki_finalize` with Wiki evidence binding, authoritative
  rescan, durable cleanup intent, exact compare-and-delete, and audit events.
- Upstream-compatible Markdown mutation locking and SQLite Storage Contract
  validation.
- Recovery for `cleanup_pending`, stale candidates, interrupted cleanup, and
  dead-process locks.
- Runtime, package-install, forged-candidate, compatibility, cursor, and crash
  recovery tests.

[Unreleased]: https://github.com/chenleji/pi-memory-to-wiki/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/chenleji/pi-memory-to-wiki/releases/tag/v0.1.0
