export type Scope = "project" | "global";
export type MemoryTarget = "memory" | "failure";
export type StorageClass = "core" | "extended";
export type Decision = "approve" | "reject" | "defer";

export type ErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_CURSOR"
  | "STORAGE_CONTRACT_UNSUPPORTED"
  | "CANDIDATE_CHANGED"
  | "VERIFICATION_REQUIRED"
  | "CANDIDATE_NOT_FOUND"
  | "CLEANUP_FAILED"
  | "INTERNAL_ERROR";

export interface MarkdownCopy {
  kind: "markdown";
  storage_class: "core";
  path: string;
  entry_index: number;
  raw_hash: string;
}

export interface SqliteCopy {
  kind: "sqlite";
  storage_class: "extended";
  database: string;
  row_id: number;
  row_hash: string;
}

export type BackingCopy = MarkdownCopy | SqliteCopy;

export interface Candidate {
  candidate_id: string;
  scope: Scope;
  project: string | null;
  target: MemoryTarget;
  category: string | null;
  content: string;
  summary: string;
  created_at: string | null;
  last_referenced_at: string | null;
  storage_classes: StorageClass[];
  backing_copies: BackingCopy[];
  identity: string;
  fingerprint: string;
  eligibility: "eligible" | "excluded";
  exclusion_reason: string | null;
}

export interface StorageConfig {
  agentRoot: string;
  globalDir: string;
  projectsRoot: string;
  ledgerPath: string;
}

export interface ScanInput {
  scope: Scope;
  since?: string;
  limit?: number;
  cursor?: string;
  include_categories?: string[];
  cwd?: string;
}

export interface ScanResult {
  ok: boolean;
  status: "ok" | "error";
  error_code?: ErrorCode;
  message?: string;
  effective_scope?: Scope;
  project?: string | null;
  scope_fallback?: boolean;
  candidates: Candidate[];
  next_cursor: string | null;
}

export interface WikiVerification {
  verified: boolean;
  candidate_id: string;
  query: string;
  page_ids: string[];
  evidence?: unknown;
  verified_at?: string;
}

export interface FinalizeInput {
  candidate: Candidate;
  decision: Decision;
  wiki_verification?: WikiVerification;
  wiki_action?: "new" | "supplement" | "existing" | "wiki_wins" | "hermes_wins";
}

export interface CleanupResult {
  removed_markdown: number;
  removed_sqlite: number;
  already_absent: number;
}

export interface FinalizeResult {
  ok: boolean;
  status: "promoted" | "rejected" | "deferred" | "cleanup_pending" | "error";
  error_code?: ErrorCode;
  message?: string;
  candidate_id: string;
  cleanup?: CleanupResult;
  idempotent_replay?: boolean;
}
