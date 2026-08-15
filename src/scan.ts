import { sha256 } from "./identity.js";
import { HermesAdapter, resolveProject, resolveStorageConfig, StorageContractError } from "./hermes-adapter.js";
import { PromotionLedger } from "./ledger.js";
import type { Candidate, ErrorCode, ScanInput, ScanResult, StorageConfig } from "./model.js";

function parseSince(value: string | undefined, now = new Date()): string {
  if (!value) return new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  const duration = value.match(/^(\d+)([dhw])$/i);
  if (duration) {
    const count = Number(duration[1]);
    const days = duration[2].toLowerCase() === "h" ? count / 24 : duration[2].toLowerCase() === "w" ? count * 7 : count;
    return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new InputError(`Invalid since value: ${value}`);
  return date.toISOString().slice(0, 10);
}

class InputError extends Error {}

interface CursorPayload { after: string; query: string }
function encodeCursor(value: CursorPayload): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function decodeCursor(value: string): CursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<CursorPayload>;
    if (typeof parsed.after !== "string" || typeof parsed.query !== "string") throw new Error();
    return parsed as CursorPayload;
  } catch { throw new CursorError("Cursor is invalid or corrupted"); }
}
class CursorError extends Error {}

export async function memoryToWikiScan(
  input: ScanInput,
  options: { config?: StorageConfig; now?: Date; adapter?: HermesAdapter } = {},
): Promise<ScanResult> {
  try {
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new InputError("limit must be an integer from 1 to 100");
    if (input.scope !== "project" && input.scope !== "global") throw new InputError("scope must be project or global");
    const config = options.config ?? resolveStorageConfig();
    let effectiveScope = input.scope;
    let project: string | null = null;
    let scopeFallback = false;
    if (input.scope === "project") {
      project = resolveProject(input.cwd ?? process.cwd());
      if (!project) { effectiveScope = "global"; scopeFallback = true; }
    }
    const cutoff = parseSince(input.since, options.now);
    const categories = input.include_categories ? [...new Set(input.include_categories)].sort() : null;
    const query = sha256(JSON.stringify([effectiveScope, project, cutoff, categories]));
    const after = input.cursor ? (() => {
      const cursor = decodeCursor(input.cursor!);
      if (cursor.query !== query) throw new CursorError("Cursor does not belong to this scan query");
      return cursor.after;
    })() : null;

    const adapter = options.adapter ?? new HermesAdapter(config);
    const processed = PromotionLedger.processedCandidateIds(config.ledgerPath);
    let candidates = (await adapter.scan(effectiveScope, project))
      .filter((candidate) => !processed.has(candidate.candidate_id))
      .filter((candidate) => !categories || categories.includes(candidate.category ?? "uncategorized"))
      .filter((candidate) => {
        const evidence = candidate.last_referenced_at ?? candidate.created_at;
        return evidence === null || evidence >= cutoff;
      });
    const sortKey = (candidate: Candidate): string => `${candidate.last_referenced_at ?? candidate.created_at ?? ""}:${candidate.candidate_id}`;
    candidates = candidates.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
    if (after !== null) candidates = candidates.filter((candidate) => sortKey(candidate) < after);
    const page = candidates.slice(0, limit);
    const next = page.length < candidates.length ? encodeCursor({ after: sortKey(page.at(-1)!), query }) : null;
    return { ok: true, status: "ok", effective_scope: effectiveScope, project, scope_fallback: scopeFallback, candidates: page, next_cursor: next };
  } catch (error) {
    let code: ErrorCode = "INTERNAL_ERROR";
    if (error instanceof InputError) code = "INVALID_ARGUMENT";
    else if (error instanceof CursorError) code = "INVALID_CURSOR";
    else if (error instanceof StorageContractError) code = "STORAGE_CONTRACT_UNSUPPORTED";
    return { ok: false, status: "error", error_code: code, message: error instanceof Error ? error.message : String(error), candidates: [], next_cursor: null };
  }
}
