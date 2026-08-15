import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { HermesAdapter } from "../src/hermes-adapter.js";
import { PromotionLedger } from "../src/ledger.js";
import { memoryToWikiFinalize } from "../src/finalize.js";
import { memoryToWikiScan } from "../src/scan.js";
import { candidateFingerprint, sha256 } from "../src/identity.js";
import type { Candidate, StorageConfig } from "../src/model.js";

interface Fixture { root: string; config: StorageConfig; db: DatabaseSync; adapter: HermesAdapter; close(): void }
function fixture(): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), "memory-to-wiki-"));
  const agentRoot = path.join(root, "agent");
  const globalDir = path.join(agentRoot, "pi-hermes-memory");
  mkdirSync(globalDir, { recursive: true });
  const database = path.join(globalDir, "sessions.db");
  const db = new DatabaseSync(database);
  db.exec(`
    CREATE TABLE memories(id INTEGER PRIMARY KEY AUTOINCREMENT,project TEXT,target TEXT NOT NULL,category TEXT,content TEXT NOT NULL,failure_reason TEXT,tool_state TEXT,corrected_to TEXT,created TEXT NOT NULL,last_referenced TEXT NOT NULL);
    CREATE VIRTUAL TABLE memory_fts USING fts5(content,content='memories',content_rowid='id');
    CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN INSERT INTO memory_fts(rowid,content) VALUES(new.id,new.content); END;
    CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN INSERT INTO memory_fts(memory_fts,rowid,content) VALUES('delete',old.id,old.content); END;
    CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN INSERT INTO memory_fts(memory_fts,rowid,content) VALUES('delete',old.id,old.content); INSERT INTO memory_fts(rowid,content) VALUES(new.id,new.content); END;
  `);
  const config: StorageConfig = { agentRoot, globalDir, projectsRoot: path.join(agentRoot, "projects-memory"), ledgerPath: path.join(agentRoot, "pi-memory-to-wiki", "ledger.sqlite") };
  return { root, config, db, adapter: new HermesAdapter(config), close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

function addMirrored(f: Fixture, content = "Use pnpm for JavaScript projects", date = "2026-08-14"): void {
  writeFileSync(path.join(f.config.globalDir, "MEMORY.md"), `${content} <!-- created=${date}, last=${date} -->\n`);
  f.db.prepare("INSERT INTO memories(project,target,category,content,failure_reason,tool_state,corrected_to,created,last_referenced) VALUES(NULL,'memory',NULL,?,NULL,NULL,NULL,?,?)").run(content, date, date);
}

function verification(candidateId = "") { return { verified: true, candidate_id: candidateId, query: "pnpm JavaScript projects", page_ids: ["concepts/package-management"] }; }

test("scan folds Core and Extended mirrors into one stable candidate without writing a ledger", async () => {
  const f = fixture();
  try {
    addMirrored(f);
    const first = await memoryToWikiScan({ scope: "global", since: "7d", limit: 20 }, { config: f.config, adapter: f.adapter, now: new Date("2026-08-15T00:00:00Z") });
    const second = await memoryToWikiScan({ scope: "global", since: "7d", limit: 20 }, { config: f.config, adapter: f.adapter, now: new Date("2026-08-15T00:00:00Z") });
    assert.equal(first.ok, true);
    assert.equal(first.candidates.length, 1);
    assert.deepEqual(first.candidates[0].storage_classes, ["core", "extended"]);
    assert.equal(first.candidates[0].backing_copies.length, 2);
    assert.equal(first.candidates[0].candidate_id, second.candidates[0].candidate_id);
    assert.equal(first.candidates[0].fingerprint, second.candidates[0].fingerprint);
    assert.equal(existsSync(f.config.ledgerPath), false);
  } finally { f.close(); }
});

test("project scan includes project64-scoped failure mirrors from global failures.md", async () => {
  const f = fixture();
  try {
    const cwd = path.join(f.root, "demo");
    mkdirSync(cwd, { recursive: true });
    assert.equal(spawnSync("git", ["init", "-q", cwd]).status, 0);
    const project64 = Buffer.from("demo").toString("base64url");
    const content = "[correction] Use the production endpoint";
    writeFileSync(path.join(f.config.globalDir, "failures.md"), `${content} <!-- created=2026-08-14, last=2026-08-14, project64=${project64} -->\n`);
    f.db.prepare("INSERT INTO memories(project,target,category,content,failure_reason,tool_state,corrected_to,created,last_referenced) VALUES('demo','failure','correction',?,NULL,NULL,NULL,'2026-08-14','2026-08-14')").run(content);
    const scanned = await memoryToWikiScan({ scope: "project", cwd }, { config: f.config, adapter: f.adapter, now: new Date("2026-08-15") });
    assert.equal(scanned.effective_scope, "project");
    assert.equal(scanned.project, "demo");
    assert.equal(scanned.candidates.length, 1);
    assert.deepEqual(scanned.candidates[0].storage_classes, ["core", "extended"]);
  } finally { f.close(); }
});

test("scan paginates with query-bound opaque cursors and validates arguments", async () => {
  const f = fixture();
  try {
    for (const value of ["A", "B", "C"]) f.db.prepare("INSERT INTO memories(project,target,category,content,failure_reason,tool_state,corrected_to,created,last_referenced) VALUES(NULL,'memory',NULL,?,NULL,NULL,NULL,'2026-08-14','2026-08-14')").run(value);
    const one = await memoryToWikiScan({ scope: "global", limit: 2 }, { config: f.config, adapter: f.adapter, now: new Date("2026-08-15") });
    assert.equal(one.candidates.length, 2); assert.ok(one.next_cursor);
    const two = await memoryToWikiScan({ scope: "global", limit: 2, cursor: one.next_cursor! }, { config: f.config, adapter: f.adapter, now: new Date("2026-08-15") });
    assert.equal(two.candidates.length, 1);
    const wrong = await memoryToWikiScan({ scope: "global", limit: 2, since: "30d", cursor: one.next_cursor! }, { config: f.config, adapter: f.adapter, now: new Date("2026-08-15") });
    assert.equal(wrong.error_code, "INVALID_CURSOR");
    assert.equal((await memoryToWikiScan({ scope: "global", limit: 101 }, { config: f.config })).error_code, "INVALID_ARGUMENT");
  } finally { f.close(); }
});

test("approval requires Wiki recall evidence and then cleans both exact mirrors", async () => {
  const f = fixture();
  try {
    addMirrored(f);
    const candidate = (await f.adapter.scan("global", null))[0];
    const denied = await memoryToWikiFinalize({ candidate, decision: "approve" }, { config: f.config, adapter: f.adapter });
    assert.equal(denied.error_code, "VERIFICATION_REQUIRED");
    assert.match(readFileSync(path.join(f.config.globalDir, "MEMORY.md"), "utf8"), /pnpm/);
    const promoted = await memoryToWikiFinalize({ candidate, decision: "approve", wiki_verification: verification(candidate.candidate_id), wiki_action: "new" }, { config: f.config, adapter: f.adapter });
    assert.equal(promoted.status, "promoted");
    assert.deepEqual(promoted.cleanup, { removed_markdown: 1, removed_sqlite: 1, already_absent: 0 });
    assert.equal(readFileSync(path.join(f.config.globalDir, "MEMORY.md"), "utf8"), "");
    assert.equal((f.db.prepare("SELECT count(*) AS n FROM memories").get() as { n: number }).n, 0);
    const replay = await memoryToWikiFinalize({ candidate, decision: "approve", wiki_verification: verification(candidate.candidate_id) }, { config: f.config, adapter: f.adapter });
    assert.equal(replay.idempotent_replay, true);
  } finally { f.close(); }
});

test("finalize rejects a self-consistent forged candidate outside Hermes roots", async () => {
  const f = fixture();
  try {
    addMirrored(f);
    const scanned = (await f.adapter.scan("global", null))[0];
    const victim = path.join(f.root, "victim.md");
    writeFileSync(victim, `${scanned.content}\n`);
    const forged: Candidate = structuredClone(scanned);
    const markdown = forged.backing_copies.find((copy) => copy.kind === "markdown")!;
    if (markdown.kind !== "markdown") throw new Error("fixture invariant");
    markdown.path = victim;
    markdown.entry_index = 0;
    markdown.raw_hash = sha256(scanned.content);
    forged.fingerprint = candidateFingerprint(forged);
    const denied = await memoryToWikiFinalize({ candidate: forged, decision: "approve", wiki_verification: verification(forged.candidate_id) }, { config: f.config, adapter: f.adapter });
    assert.equal(denied.error_code, "INVALID_ARGUMENT");
    assert.match(readFileSync(victim, "utf8"), /pnpm/);
  } finally { f.close(); }
});

test("cleanup intent exists before deletion and cleanup_pending safely retries", async () => {
  const f = fixture();
  const ledger = new PromotionLedger(f.config.ledgerPath);
  try {
    addMirrored(f);
    const candidate = (await f.adapter.scan("global", null))[0];
    let calls = 0;
    const fake = {
      async scan() { return [candidate]; },
      async cleanupExact(value: Candidate) {
        calls++;
        const row = ledger.get(ledger.operationKey(value, "approve"));
        assert.equal(row?.status, "cleanup_pending");
        if (calls === 1) throw new Error("injected cleanup failure");
        return f.adapter.cleanupExact(value);
      },
    } as unknown as HermesAdapter;
    const first = await memoryToWikiFinalize({ candidate, decision: "approve", wiki_verification: verification(candidate.candidate_id) }, { config: f.config, adapter: fake, ledger });
    assert.equal(first.status, "cleanup_pending");
    const retry = await memoryToWikiFinalize({ candidate, decision: "approve", wiki_verification: verification(candidate.candidate_id) }, { config: f.config, adapter: fake, ledger });
    assert.equal(retry.status, "promoted"); assert.equal(retry.idempotent_replay, true);
  } finally { ledger.close(); f.close(); }
});

test("cleanup resumes after a crash that committed SQLite deletion before Markdown", async () => {
  const f = fixture();
  try {
    addMirrored(f);
    const candidate = (await f.adapter.scan("global", null))[0];
    // A real crash at this point always has a durable cleanup intent because
    // finalize writes it before calling the adapter.
    const ledger = new PromotionLedger(f.config.ledgerPath);
    ledger.persistIntent(candidate, "approve", "cleanup_pending", verification(candidate.candidate_id));
    ledger.close();
    // Simulate a crash after the adapter committed Extended deletion but before
    // it reached the atomic Core rewrite.
    f.db.prepare("DELETE FROM memories WHERE id=1").run();
    const resumed = await memoryToWikiFinalize({ candidate, decision: "approve", wiki_verification: verification(candidate.candidate_id) }, { config: f.config, adapter: f.adapter });
    assert.equal(resumed.status, "promoted");
    assert.deepEqual(resumed.cleanup, { removed_markdown: 1, removed_sqlite: 0, already_absent: 1 });
    assert.equal(readFileSync(path.join(f.config.globalDir, "MEMORY.md"), "utf8"), "");
  } finally { f.close(); }
});

test("changed backing copy aborts before deleting any unchanged mirror", async () => {
  const f = fixture();
  try {
    addMirrored(f);
    const candidate = (await f.adapter.scan("global", null))[0];
    f.db.prepare("UPDATE memories SET content='Changed after scan' WHERE id=1").run();
    const finalized = await memoryToWikiFinalize({ candidate, decision: "approve", wiki_verification: verification(candidate.candidate_id) }, { config: f.config, adapter: f.adapter });
    assert.equal(finalized.error_code, "CANDIDATE_CHANGED");
    assert.match(readFileSync(path.join(f.config.globalDir, "MEMORY.md"), "utf8"), /pnpm/);
    assert.equal((f.db.prepare("SELECT count(*) AS n FROM memories").get() as { n: number }).n, 1);
  } finally { f.close(); }
});

test("incompatible Hermes Storage Contract refuses cleanup", async () => {
  const f = fixture();
  try {
    addMirrored(f);
    const candidate = (await f.adapter.scan("global", null))[0];
    f.db.exec("DROP TRIGGER memories_ad");
    const finalized = await memoryToWikiFinalize({ candidate, decision: "approve", wiki_verification: verification(candidate.candidate_id) }, { config: f.config, adapter: f.adapter });
    assert.equal(finalized.error_code, "STORAGE_CONTRACT_UNSUPPORTED");
    assert.match(readFileSync(path.join(f.config.globalDir, "MEMORY.md"), "utf8"), /pnpm/);
    assert.equal((f.db.prepare("SELECT count(*) AS n FROM memories").get() as { n: number }).n, 1);
  } finally { f.close(); }
});

test("reject is audited and suppressed; defer remains discoverable", async () => {
  const f = fixture();
  try {
    addMirrored(f);
    const candidate = (await f.adapter.scan("global", null))[0];
    assert.equal((await memoryToWikiFinalize({ candidate, decision: "defer" }, { config: f.config, adapter: f.adapter })).status, "deferred");
    assert.equal((await memoryToWikiScan({ scope: "global" }, { config: f.config, adapter: f.adapter })).candidates.length, 1);
    assert.equal((await memoryToWikiFinalize({ candidate, decision: "reject" }, { config: f.config, adapter: f.adapter })).status, "rejected");
    assert.equal((await memoryToWikiScan({ scope: "global" }, { config: f.config, adapter: f.adapter })).candidates.length, 0);
    assert.match(readFileSync(path.join(f.config.globalDir, "MEMORY.md"), "utf8"), /pnpm/);
  } finally { f.close(); }
});
