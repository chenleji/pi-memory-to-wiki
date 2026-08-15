import { createHash } from "node:crypto";
import type { BackingCopy, Candidate, Scope } from "./model.js";

export function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function normalizeContent(value: string): string {
  return value.normalize("NFC").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();
}

export function memoryIdentity(input: {
  scope: Scope;
  project: string | null;
  target: string;
  category: string | null;
  content: string;
}): string {
  return sha256(JSON.stringify([
    input.scope,
    input.project,
    input.target,
    input.category,
    normalizeContent(input.content),
  ]));
}

export function candidateId(identity: string): string {
  return `mtw_${sha256(identity).slice("sha256:".length, "sha256:".length + 24)}`;
}

export function backingKey(copy: BackingCopy): string {
  return copy.kind === "markdown"
    ? `markdown:${copy.path}:${copy.entry_index}`
    : `sqlite:${copy.database}:${copy.row_id}`;
}

export function candidateFingerprint(input: Pick<Candidate,
  "identity" | "created_at" | "last_referenced_at" | "backing_copies"
>): string {
  const copies = [...input.backing_copies]
    .sort((a, b) => backingKey(a).localeCompare(backingKey(b)))
    .map((copy) => copy.kind === "markdown"
      ? [backingKey(copy), copy.raw_hash]
      : [backingKey(copy), copy.row_hash]);
  return sha256(JSON.stringify([
    input.identity,
    input.created_at,
    input.last_referenced_at,
    copies,
  ]));
}

export function summarize(content: string, max = 160): string {
  const oneLine = normalizeContent(content).replace(/\s+/g, " ");
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}
