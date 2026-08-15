import * as path from "node:path";
import { CandidateChangedError, HermesAdapter, resolveStorageConfig, StorageContractError } from "./hermes-adapter.js";
import { backingKey, candidateFingerprint, candidateId, memoryIdentity, normalizeContent } from "./identity.js";
import { PromotionLedger } from "./ledger.js";
import type { FinalizeInput, FinalizeResult, StorageConfig } from "./model.js";

function result(input: FinalizeInput, value: Omit<FinalizeResult, "candidate_id">): FinalizeResult {
  return { candidate_id: input.candidate.candidate_id, ...value };
}

function validVerification(input: FinalizeInput): boolean {
  const proof = input.wiki_verification;
  return Boolean(proof?.verified && proof.candidate_id === input.candidate.candidate_id && proof.query.trim() && proof.page_ids.length > 0);
}

function validateCandidate(candidate: FinalizeInput["candidate"], config: StorageConfig): string | null {
  if (!candidate?.candidate_id || !candidate.fingerprint || !candidate.identity || !normalizeContent(candidate.content)) return "A complete scanned candidate is required";
  if (candidate.scope === "global" ? candidate.project !== null : !candidate.project) return "Candidate scope/project is inconsistent";
  if (candidate.project && (!/^[^/\\\0]+$/.test(candidate.project) || candidate.project === "." || candidate.project === "..")) return "Candidate project is invalid";
  if (candidate.target === "memory" && candidate.category !== null) return "Memory candidates cannot carry a failure category";
  if (candidate.target === "failure") {
    const category = candidate.content.match(/^\[([^\]]+)\]\s+/)?.[1] ?? null;
    if (category !== candidate.category) return "Failure category does not match content";
  }
  const identity = memoryIdentity(candidate);
  if (identity !== candidate.identity || candidateId(identity) !== candidate.candidate_id) return "Candidate identity is invalid";
  if (candidateFingerprint(candidate) !== candidate.fingerprint) return "Candidate fingerprint is invalid";
  if (!candidate.backing_copies.length || new Set(candidate.backing_copies.map(backingKey)).size !== candidate.backing_copies.length) return "Candidate backing copies are empty or duplicated";

  const expectedMarkdown = candidate.target === "failure"
    ? path.join(config.globalDir, "failures.md")
    : candidate.scope === "project"
      ? path.join(config.projectsRoot, candidate.project!, "MEMORY.md")
      : path.join(config.globalDir, "MEMORY.md");
  const expectedDatabase = path.join(config.globalDir, "sessions.db");
  for (const copy of candidate.backing_copies) {
    if (copy.kind === "markdown") {
      if (copy.storage_class !== "core" || path.resolve(copy.path) !== path.resolve(expectedMarkdown) || !Number.isSafeInteger(copy.entry_index) || copy.entry_index < 0) return "Markdown backing copy is outside the candidate storage scope";
    } else if (copy.storage_class !== "extended" || path.resolve(copy.database) !== path.resolve(expectedDatabase) || !Number.isSafeInteger(copy.row_id) || copy.row_id < 1) {
      return "SQLite backing copy is outside the Hermes database";
    }
  }
  const storageClasses = [...new Set(candidate.backing_copies.map((copy) => copy.storage_class))].sort();
  if (JSON.stringify(storageClasses) !== JSON.stringify([...candidate.storage_classes].sort())) return "Candidate storage classes do not match backing copies";
  return null;
}

export async function memoryToWikiFinalize(
  input: FinalizeInput,
  options: { config?: StorageConfig; adapter?: HermesAdapter; ledger?: PromotionLedger } = {},
): Promise<FinalizeResult> {
  const config = options.config ?? resolveStorageConfig();
  const adapter = options.adapter ?? new HermesAdapter(config);
  const ledger = options.ledger ?? new PromotionLedger(config.ledgerPath);
  const ownsLedger = !options.ledger;
  try {
    const candidateError = validateCandidate(input.candidate, config);
    if (candidateError) return result(input, { ok: false, status: "error", error_code: "INVALID_ARGUMENT", message: candidateError });
    if (!["approve", "reject", "defer"].includes(input.decision)) {
      return result(input, { ok: false, status: "error", error_code: "INVALID_ARGUMENT", message: "decision must be approve, reject, or defer" });
    }
    if (input.decision === "approve" && !validVerification(input)) {
      return result(input, { ok: false, status: "error", error_code: "VERIFICATION_REQUIRED", message: "Approval requires successful post-write Wiki recall evidence with at least one page id" });
    }

    const key = ledger.operationKey(input.candidate);
    const previous = ledger.get(key);
    if (previous?.status === "promoted") {
      return result(input, { ok: true, status: "promoted", cleanup: previous.cleanup_result_json ? JSON.parse(previous.cleanup_result_json) : undefined, idempotent_replay: true });
    }
    if (previous?.status === "rejected") return result(input, { ok: true, status: "rejected", idempotent_replay: true });
    if (previous?.status === "deferred" && input.decision === "defer") return result(input, { ok: true, status: "deferred", idempotent_replay: true });
    if (previous?.status === "cleanup_pending" && input.decision !== "approve") {
      return result(input, { ok: false, status: "cleanup_pending", error_code: "INVALID_ARGUMENT", message: "An approved cleanup is already pending and cannot change decision" });
    }

    let authoritative = input.candidate;
    if (!previous) {
      try {
        const current = await adapter.scan(input.candidate.scope, input.candidate.project);
        const sameId = current.find(({ candidate_id }) => candidate_id === input.candidate.candidate_id);
        if (!sameId) return result(input, { ok: false, status: "error", error_code: "CANDIDATE_CHANGED", message: "Candidate is absent or changed in current Hermes Memory; scan again before finalizing" });
        if (sameId.fingerprint !== input.candidate.fingerprint) return result(input, { ok: false, status: "error", error_code: "CANDIDATE_CHANGED", message: "Candidate changed after scan; scan again before finalizing" });
        authoritative = sameId;
      } catch (error) {
        if (error instanceof StorageContractError) return result(input, { ok: false, status: "error", error_code: "STORAGE_CONTRACT_UNSUPPORTED", message: error.message });
        throw error;
      }
    } else {
      authoritative = JSON.parse(previous.candidate_json) as FinalizeInput["candidate"];
    }

    if (input.decision === "reject") {
      ledger.persistIntent(authoritative, input.decision, "rejected");
      return result(input, { ok: true, status: "rejected" });
    }
    if (input.decision === "defer") {
      ledger.persistIntent(authoritative, input.decision, "deferred");
      return result(input, { ok: true, status: "deferred" });
    }

    ledger.persistIntent(authoritative, input.decision, "cleanup_pending", input.wiki_verification);
    try {
      const cleanup = await adapter.cleanupExact(authoritative);
      ledger.finish(key, "promoted", { cleanup });
      return result(input, { ok: true, status: "promoted", cleanup, idempotent_replay: previous?.status === "cleanup_pending" });
    } catch (error) {
      const errorCode = error instanceof CandidateChangedError ? "CANDIDATE_CHANGED"
        : error instanceof StorageContractError ? "STORAGE_CONTRACT_UNSUPPORTED" : "CLEANUP_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      ledger.finish(key, "cleanup_pending", { errorCode, errorMessage: message });
      return result(input, { ok: false, status: "cleanup_pending", error_code: errorCode, message });
    }
  } catch (error) {
    return result(input, { ok: false, status: "error", error_code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) });
  } finally { if (ownsLedger) ledger.close(); }
}
