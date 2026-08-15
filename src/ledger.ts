import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Candidate, Decision, FinalizeResult, WikiVerification } from "./model.js";

export interface LedgerRecord {
  operation_key: string;
  candidate_id: string;
  fingerprint: string;
  decision: Decision;
  status: FinalizeResult["status"];
  candidate_json: string;
  wiki_verification_json: string | null;
  cleanup_result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export class PromotionLedger {
  private db: DatabaseSync;

  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const existed = fs.existsSync(file);
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS promotions(
        operation_key TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        decision TEXT NOT NULL,
        status TEXT NOT NULL,
        candidate_json TEXT NOT NULL,
        wiki_verification_json TEXT,
        cleanup_result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS promotions_candidate ON promotions(candidate_id, updated_at);
      CREATE TABLE IF NOT EXISTS audit_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_key TEXT NOT NULL,
        event TEXT NOT NULL,
        detail_json TEXT,
        created_at TEXT NOT NULL
      );
    `);
    if (!existed) fs.chmodSync(file, 0o600);
  }

  static processedCandidateIds(file: string): Set<string> {
    if (!fs.existsSync(file)) return new Set();
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = db.prepare("SELECT DISTINCT candidate_id FROM promotions WHERE status IN ('promoted','rejected')").all() as Array<{ candidate_id: string }>;
      return new Set(rows.map(({ candidate_id }) => candidate_id));
    } finally { db.close(); }
  }

  operationKey(candidate: Candidate, _decision?: Decision): string {
    return `${candidate.candidate_id}:${candidate.fingerprint}`;
  }

  get(key: string): LedgerRecord | null {
    return (this.db.prepare("SELECT * FROM promotions WHERE operation_key=?").get(key) as LedgerRecord | undefined) ?? null;
  }

  persistIntent(candidate: Candidate, decision: Decision, status: FinalizeResult["status"], verification?: WikiVerification): LedgerRecord {
    const key = this.operationKey(candidate, decision);
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO promotions(operation_key,candidate_id,fingerprint,decision,status,candidate_json,wiki_verification_json,cleanup_result_json,error_code,error_message,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(operation_key) DO UPDATE SET decision=excluded.decision,status=excluded.status,candidate_json=excluded.candidate_json,wiki_verification_json=excluded.wiki_verification_json,updated_at=excluded.updated_at`)
        .run(key, candidate.candidate_id, candidate.fingerprint, decision, status, JSON.stringify(candidate), verification ? JSON.stringify(verification) : null, null, null, null, now, now);
      this.event(key, "intent_persisted", { decision, status });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.get(key)!;
  }

  finish(key: string, status: FinalizeResult["status"], detail: { cleanup?: unknown; errorCode?: string; errorMessage?: string }): void {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE promotions SET status=?,cleanup_result_json=?,error_code=?,error_message=?,updated_at=? WHERE operation_key=?")
        .run(status, detail.cleanup ? JSON.stringify(detail.cleanup) : null, detail.errorCode ?? null, detail.errorMessage ?? null, now, key);
      this.event(key, status, detail);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private event(key: string, event: string, detail: unknown): void {
    this.db.prepare("INSERT INTO audit_events(operation_key,event,detail_json,created_at) VALUES(?,?,?,?)")
      .run(key, event, JSON.stringify(detail), new Date().toISOString());
  }

  close(): void { this.db.close(); }
}
