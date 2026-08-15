import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { backingKey, candidateFingerprint, candidateId, memoryIdentity, normalizeContent, sha256, summarize } from "./identity.js";
import type { BackingCopy, Candidate, CleanupResult, MemoryTarget, Scope, StorageConfig } from "./model.js";

const DELIMITER = "§";
const META = /^(.*?)\s*<!--\s*created=([^,]+),\s*last=([^,>]+)(?:,\s*project64=([A-Za-z0-9_-]+))?\s*-->\s*$/s;
const REQUIRED_COLUMNS = ["id", "project", "target", "category", "content", "failure_reason", "tool_state", "corrected_to", "created", "last_referenced"];
const REQUIRED_TRIGGERS = ["memories_ai", "memories_ad", "memories_au"];

export class StorageContractError extends Error {}
export class CandidateChangedError extends Error {}

interface NormalizedRecord {
  scope: Scope;
  project: string | null;
  target: MemoryTarget;
  category: string | null;
  content: string;
  created: string | null;
  lastReferenced: string | null;
  copy: BackingCopy;
}

export function resolveStorageConfig(env: Record<string, string | undefined> = process.env): StorageConfig {
  const expand = (value: string): string => value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
  const agentRoot = env.PI_CODING_AGENT_DIR?.trim()
    ? path.resolve(expand(env.PI_CODING_AGENT_DIR.trim()))
    : path.join(os.homedir(), ".pi", "agent");
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(fs.readFileSync(path.join(agentRoot, "hermes-memory-config.json"), "utf8")) as Record<string, unknown>; } catch {}
  const configured = typeof raw.memoryDir === "string" ? expand(raw.memoryDir.trim()) : "";
  const globalDir = configured ? (path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(agentRoot, configured)) : path.join(agentRoot, "pi-hermes-memory");
  const projectDir = typeof raw.projectsMemoryDir === "string" && /^[^/\\.][^/\\]*$/.test(raw.projectsMemoryDir.trim())
    ? raw.projectsMemoryDir.trim() : "projects-memory";
  const extensionDir = path.join(agentRoot, "pi-memory-to-wiki");
  return {
    agentRoot,
    globalDir,
    projectsRoot: path.join(agentRoot, projectDir),
    ledgerPath: path.join(extensionDir, "promotion-ledger.sqlite"),
  };
}

export function resolveProject(cwd: string): string | null {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 5_000 });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  return path.basename(result.stdout.trim());
}

function parseEntry(raw: string): { content: string; created: string | null; last: string | null; project: string | null } {
  const match = raw.match(META);
  if (!match) return { content: normalizeContent(raw), created: null, last: null, project: null };
  let project: string | null = null;
  if (match[4]) {
    try { project = Buffer.from(match[4], "base64url").toString("utf8").trim() || null; } catch {}
  }
  return { content: normalizeContent(match[1]), created: match[2].trim() || null, last: match[3].trim() || null, project };
}

function failureCategory(content: string): string | null {
  const value = content.match(/^\[([^\]]+)\]\s+/)?.[1];
  return value && ["failure", "correction", "insight", "preference", "convention", "tool-quirk"].includes(value) ? value : null;
}

function splitEntries(raw: string): string[] {
  return raw.trim() ? raw.split(DELIMITER).map((entry) => entry.trim()).filter(Boolean) : [];
}

function rowHash(row: Record<string, unknown>): string {
  return sha256(JSON.stringify(REQUIRED_COLUMNS.map((column) => row[column] ?? null)));
}

function assertStorageContract(db: DatabaseSync): void {
  const columns = new Set((db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map(({ name }) => name));
  const missing = REQUIRED_COLUMNS.filter((name) => !columns.has(name));
  if (missing.length) throw new StorageContractError(`memories missing columns: ${missing.join(", ")}`);
  const triggers = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as Array<{ name: string }>).map(({ name }) => name));
  const missingTriggers = REQUIRED_TRIGGERS.filter((name) => !triggers.has(name));
  if (missingTriggers.length) throw new StorageContractError(`missing triggers: ${missingTriggers.join(", ")}`);
}

function memoryDb(config: StorageConfig): string {
  return path.join(config.globalDir, "sessions.db");
}

async function readText(file: string): Promise<string> {
  try { return await fsp.readFile(file, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function markdownLocations(config: StorageConfig, scope: Scope, project: string | null): Array<{ path: string; target: MemoryTarget; project: string | null }> {
  if (scope === "project" && project) {
    return [
      { path: path.join(config.projectsRoot, project, "MEMORY.md"), target: "memory", project },
      // Project-scoped failure/correction entries remain in the global
      // failures.md and carry their scope in project64 metadata.
      { path: path.join(config.globalDir, "failures.md"), target: "failure", project: null },
    ];
  }
  return [
    { path: path.join(config.globalDir, "MEMORY.md"), target: "memory", project: null },
    { path: path.join(config.globalDir, "failures.md"), target: "failure", project: null },
  ];
}

export class HermesAdapter {
  constructor(readonly config: StorageConfig) {}

  async scan(scope: Scope, project: string | null): Promise<Candidate[]> {
    const records: NormalizedRecord[] = [];
    for (const location of markdownLocations(this.config, scope, project)) {
      const entries = splitEntries(await readText(location.path));
      entries.forEach((raw, entryIndex) => {
        const parsed = parseEntry(raw);
        const effectiveProject = location.project ?? parsed.project;
        const effectiveScope: Scope = effectiveProject ? "project" : "global";
        if (effectiveScope !== scope || (scope === "project" && effectiveProject !== project)) return;
        const category = location.target === "failure" ? failureCategory(parsed.content) : null;
        records.push({
          scope: effectiveScope, project: effectiveProject, target: location.target, category,
          content: parsed.content, created: parsed.created, lastReferenced: parsed.last,
          copy: { kind: "markdown", storage_class: "core", path: location.path, entry_index: entryIndex, raw_hash: sha256(raw) },
        });
      });
    }

    const database = memoryDb(this.config);
    if (fs.existsSync(database)) {
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        assertStorageContract(db);
        const rows = db.prepare(`SELECT ${REQUIRED_COLUMNS.join(",")} FROM memories ORDER BY id`).all() as Array<Record<string, unknown>>;
        for (const row of rows) {
          const target = String(row.target);
          if (target !== "memory" && target !== "failure") continue;
          const rowProject = typeof row.project === "string" && row.project.trim() ? row.project.trim() : null;
          const rowScope: Scope = rowProject ? "project" : "global";
          if (rowScope !== scope || (scope === "project" && rowProject !== project)) continue;
          const content = normalizeContent(String(row.content ?? ""));
          if (!content) continue;
          records.push({
            scope: rowScope, project: rowProject, target, category: typeof row.category === "string" ? row.category : null,
            content, created: typeof row.created === "string" ? row.created : null,
            lastReferenced: typeof row.last_referenced === "string" ? row.last_referenced : null,
            copy: { kind: "sqlite", storage_class: "extended", database, row_id: Number(row.id), row_hash: rowHash(row) },
          });
        }
      } finally { db.close(); }
    }

    const grouped = new Map<string, NormalizedRecord[]>();
    for (const record of records) {
      const identity = memoryIdentity(record);
      const list = grouped.get(identity) ?? [];
      list.push(record);
      grouped.set(identity, list);
    }
    return [...grouped.entries()].map(([identity, copies]) => {
      const first = copies[0];
      const dates = copies.map((copy) => copy.created).filter((v): v is string => Boolean(v)).sort();
      const refs = copies.map((copy) => copy.lastReferenced).filter((v): v is string => Boolean(v)).sort();
      const backing = copies.map(({ copy }) => copy).sort((a, b) => backingKey(a).localeCompare(backingKey(b)));
      const candidate: Candidate = {
        candidate_id: candidateId(identity), identity, scope: first.scope, project: first.project,
        target: first.target, category: first.category, content: first.content, summary: summarize(first.content),
        created_at: dates[0] ?? null, last_referenced_at: refs.at(-1) ?? null,
        storage_classes: [...new Set(backing.map((copy) => copy.storage_class))].sort() as Candidate["storage_classes"],
        backing_copies: backing, fingerprint: "", eligibility: "eligible", exclusion_reason: null,
      };
      candidate.fingerprint = candidateFingerprint(candidate);
      return candidate;
    }).sort((a, b) => `${b.last_referenced_at ?? ""}:${b.candidate_id}`.localeCompare(`${a.last_referenced_at ?? ""}:${a.candidate_id}`));
  }

  async cleanupExact(candidate: Candidate): Promise<CleanupResult> {
    const expected = new Map(candidate.backing_copies.map((copy) => [backingKey(copy), copy]));
    const result: CleanupResult = { removed_markdown: 0, removed_sqlite: 0, already_absent: 0 };
    const markdownByPath = new Map<string, Extract<BackingCopy, { kind: "markdown" }>[]>();
    for (const copy of candidate.backing_copies) {
      if (copy.kind === "markdown") {
        const list = markdownByPath.get(copy.path) ?? [];
        list.push(copy);
        markdownByPath.set(copy.path, list);
      }
    }
    const sqliteCopies = candidate.backing_copies.filter(
      (copy): copy is Extract<BackingCopy, { kind: "sqlite" }> => copy.kind === "sqlite",
    );
    const leases: LockLease[] = [];
    let db: DatabaseSync | null = null;
    let transactionOpen = false;
    try {
      // Hold the same Markdown mutation leases used by pi-hermes-memory before
      // validating anything. Hold an IMMEDIATE SQLite transaction across the
      // Markdown writes so a changed SQLite mirror can never be discovered only
      // after an unchanged Core copy has already been removed.
      for (const file of [...markdownByPath.keys()].sort()) leases.push(await acquireMarkdownLock(file));
      const database = sqliteCopies[0]?.database ?? memoryDb(this.config);
      if (!fs.existsSync(database)) {
        throw new StorageContractError(`Hermes memory database is missing: ${database}`);
      }
      db = new DatabaseSync(database);
      assertStorageContract(db);
      db.exec("BEGIN IMMEDIATE");
      transactionOpen = true;

      const markdownPlans: Array<{ file: string; entries: string[]; remove: Set<number> }> = [];
      for (const [file, copies] of markdownByPath) {
        const entries = splitEntries(await readText(file));
        const remove = new Set<number>();
        for (const copy of copies) {
          const raw = entries[copy.entry_index];
          if (raw === undefined) { result.already_absent++; continue; }
          if (sha256(raw) !== copy.raw_hash) {
            throw new CandidateChangedError(`Markdown entry changed: ${file}#${copy.entry_index}`);
          }
          remove.add(copy.entry_index);
        }
        // Detect a new duplicate/mirror of the same logical identity that was
        // not part of the reviewed scan fingerprint.
        entries.forEach((raw, index) => {
          const parsed = parseEntry(raw);
          const isFailureFile = file.endsWith("failures.md");
          const target = copies[0]?.kind === "markdown"
            ? (isFailureFile ? "failure" : "memory")
            : candidate.target;
          const project = isFailureFile
            ? parsed.project
            : candidate.scope === "project" ? candidate.project : parsed.project;
          const category = target === "failure" ? failureCategory(parsed.content) : null;
          const identity = memoryIdentity({ scope: project ? "project" : "global", project, target, category, content: parsed.content });
          const key = `markdown:${file}:${index}`;
          if (identity === candidate.identity && !expected.has(key)) {
            throw new CandidateChangedError(`Unexpected Markdown backing copy: ${key}`);
          }
        });
        markdownPlans.push({ file, entries, remove });
      }

      if (db) {
        const rows = db.prepare(`SELECT ${REQUIRED_COLUMNS.join(",")} FROM memories ORDER BY id`).all() as Array<Record<string, unknown>>;
        for (const row of rows) {
          const project = typeof row.project === "string" && row.project.trim() ? row.project.trim() : null;
          const target = String(row.target);
          if (target !== "memory" && target !== "failure") continue;
          const identity = memoryIdentity({
            scope: project ? "project" : "global", project, target,
            category: typeof row.category === "string" ? row.category : null,
            content: String(row.content ?? ""),
          });
          if (identity !== candidate.identity) continue;
          const key = `sqlite:${database}:${Number(row.id)}`;
          const prior = expected.get(key);
          if (!prior || prior.kind !== "sqlite" || rowHash(row) !== prior.row_hash) {
            throw new CandidateChangedError(`SQLite backing copy changed: ${key}`);
          }
        }
        for (const copy of sqliteCopies) {
          const row = db.prepare(`SELECT ${REQUIRED_COLUMNS.join(",")} FROM memories WHERE id=?`).get(copy.row_id) as Record<string, unknown> | undefined;
          if (!row) { result.already_absent++; continue; }
          if (rowHash(row) !== copy.row_hash) throw new CandidateChangedError(`SQLite row changed: ${copy.row_id}`);
        }
      }

      // Commit exact Extended deletions first. If the process crashes after
      // this point, the still-locked/unmodified Markdown copies retain their
      // scanned indexes and a retry treats SQLite rows as already absent.
      if (db) {
        for (const copy of sqliteCopies) {
          const exists = db.prepare("SELECT 1 AS present FROM memories WHERE id=?").get(copy.row_id);
          if (exists) result.removed_sqlite += Number(db.prepare("DELETE FROM memories WHERE id=?").run(copy.row_id).changes);
        }
        db.exec("COMMIT");
        transactionOpen = false;
      }
      for (const plan of markdownPlans) {
        if (!plan.remove.size) continue;
        await atomicWrite(plan.file, plan.entries.filter((_entry, index) => !plan.remove.has(index)).join(DELIMITER));
        result.removed_markdown += plan.remove.size;
      }
      return result;
    } catch (error) {
      if (db && transactionOpen) db.exec("ROLLBACK");
      throw error;
    } finally {
      db?.close();
      for (let index = leases.length - 1; index >= 0; index--) leases[index].release();
    }
  }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.mtw-${process.pid}-${randomUUID()}.tmp`;
  await fsp.writeFile(temp, content ? `${content}\n` : "", { mode: 0o600 });
  await fsp.rename(temp, file);
}

type LockLease = { release(): void };
const coordinators = new Map<string, DatabaseSync>();

function canonicalStoragePath(file: string): string {
  const absolute = path.resolve(file);
  let current = path.parse(absolute).root;
  const parts = absolute.slice(current.length).split(path.sep).filter(Boolean);
  while (parts.length) {
    const part = parts.shift()!;
    const candidate = path.join(current, part);
    try { current = fs.realpathSync.native(candidate); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return path.join(fs.realpathSync.native(current), part, ...parts);
    }
  }
  return current;
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function acquireMarkdownLock(file: string): Promise<LockLease> {
  const identity = canonicalStoragePath(file);
  const coordinatorPath = path.join(path.dirname(path.dirname(identity)), ".pi-hermes-locks.sqlite");
  let db = coordinators.get(coordinatorPath);
  if (!db) {
    fs.mkdirSync(path.dirname(coordinatorPath), { recursive: true });
    const existed = fs.existsSync(coordinatorPath);
    db = new DatabaseSync(coordinatorPath);
    db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS locks(lock_key TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, incarnation TEXT, acquired_at INTEGER NOT NULL)");
    if (!existed) fs.chmodSync(coordinatorPath, 0o600);
    coordinators.set(coordinatorPath, db);
  }
  const key = `mutation:${identity}`;
  const token = randomUUID();
  const deadline = Date.now() + 5_000;
  while (true) {
    const now = Date.now();
    let acquired = false;
    db.exec("BEGIN IMMEDIATE");
    try {
      const owner = db.prepare("SELECT token,pid,acquired_at FROM locks WHERE lock_key=?").get(key) as { token: string; pid: number; acquired_at: number } | undefined;
      if (!owner) {
        db.prepare("INSERT INTO locks(lock_key,token,pid,incarnation,acquired_at) VALUES(?,?,?,NULL,?)").run(key, token, process.pid, now);
        acquired = true;
      } else if (now - owner.acquired_at >= 300_000 || !processAlive(owner.pid)) {
        acquired = Number(db.prepare("UPDATE locks SET token=?,pid=?,incarnation=NULL,acquired_at=? WHERE lock_key=? AND token=?").run(token, process.pid, now, key, owner.token).changes) === 1;
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    if (acquired) return { release: () => { db!.prepare("DELETE FROM locks WHERE lock_key=? AND token=?").run(key, token); } };
    if (Date.now() >= deadline) throw new Error(`Memory mutation already in progress for ${identity}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
