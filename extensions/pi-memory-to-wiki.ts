import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { memoryToWikiFinalize } from "../src/finalize.js";
import { memoryToWikiScan } from "../src/scan.js";
import type { FinalizeInput, ScanInput } from "../src/model.js";

const Scope = Type.Union([Type.Literal("project"), Type.Literal("global")]);
const BackingCopy = Type.Union([
  Type.Object({ kind: Type.Literal("markdown"), storage_class: Type.Literal("core"), path: Type.String(), entry_index: Type.Number(), raw_hash: Type.String() }),
  Type.Object({ kind: Type.Literal("sqlite"), storage_class: Type.Literal("extended"), database: Type.String(), row_id: Type.Number(), row_hash: Type.String() }),
]);
const Candidate = Type.Object({
  candidate_id: Type.String(), scope: Scope, project: Type.Union([Type.String(), Type.Null()]),
  target: Type.Union([Type.Literal("memory"), Type.Literal("failure")]), category: Type.Union([Type.String(), Type.Null()]),
  content: Type.String(), summary: Type.String(), created_at: Type.Union([Type.String(), Type.Null()]),
  last_referenced_at: Type.Union([Type.String(), Type.Null()]), storage_classes: Type.Array(Type.Union([Type.Literal("core"), Type.Literal("extended")])),
  backing_copies: Type.Array(BackingCopy), identity: Type.String(), fingerprint: Type.String(),
  eligibility: Type.Union([Type.Literal("eligible"), Type.Literal("excluded")]), exclusion_reason: Type.Union([Type.String(), Type.Null()]),
});

export function parseCommandArgs(raw: string): Omit<ScanInput, "cwd"> {
  const tokens = raw.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((token) => token.replace(/^"|"$/g, "")) ?? [];
  const result: Omit<ScanInput, "cwd"> = { scope: "project", since: "7d", limit: 20 };
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (!value) throw new Error(`${flag} requires a value`);
    if (flag === "--scope" && (value === "project" || value === "global")) result.scope = value;
    else if (flag === "--since") result.since = value;
    else if (flag === "--limit") result.limit = Number(value);
    else if (flag === "--cursor") result.cursor = value;
    else throw new Error(`Unsupported option: ${flag}`);
  }
  return result;
}

export function orchestrationPrompt(args: Omit<ScanInput, "cwd">): string {
  return `Run the human-reviewed Memory to Wiki promotion workflow now.

1. Call memory_to_wiki_scan with ${JSON.stringify(args)}.
2. For every candidate, call BOTH wiki_recall (semantic comparison) and wiki_search (exact terms/title comparison). Do not infer absence from only one method.
3. Classify each candidate as new, supplement, existing, conflict, or skip. Show full content, summary, scope/category/dates/storage classes, Wiki hits, proposed public Wiki operation, target pages, and exact Hermes copies that would be deleted.
4. Ask the user to approve, reject, defer, or resolve each conflict. Batch approval is allowed only for non-conflicting items. Do not mutate Wiki or Hermes before approval.
5. For approved atomic insights prefer wiki_retro. For source-rich/deep content use wiki_capture_source then wiki_ingest. Use wiki_ensure_page only for missing canonical concepts/entities. Existing equivalent knowledge requires no duplicate write.
6. After writing or confirming an existing page, call wiki_recall again. Only evidence that returns the target knowledge/page counts as verification.
7. Call memory_to_wiki_finalize for each decision. Approval must include verified=true, the exact candidate_id being verified, the verification query, and returned page_ids. Conflicts default to defer unless the user explicitly chooses Wiki or Hermes.
8. Report promoted, rejected, deferred, conflicts, cleanup_pending, failures, and the next cursor. Never call finalize approval without user approval and post-write recall evidence.

This command does not replace direct wiki_capture_source/wiki_ingest for user-supplied sources.`;
}

function toolResult(value: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value as Record<string, unknown>, ...(isError ? { isError: true } : {}) };
}

export default function memoryToWikiExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "memory_to_wiki_scan",
    label: "Memory to Wiki Scan",
    description: "Read-only scan of current Hermes Core and Extended Memory. Folds storage mirrors and excludes already promoted/rejected candidates. Never writes Wiki, Hermes, or the audit ledger.",
    parameters: Type.Object({
      scope: Scope,
      since: Type.Optional(Type.String({ default: "7d" })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, default: 20 })),
      cursor: Type.Optional(Type.String()),
      include_categories: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const value = await memoryToWikiScan({ ...(params as ScanInput), cwd: ctx.cwd });
      return toolResult(value, !value.ok);
    },
  });

  pi.registerTool({
    name: "memory_to_wiki_finalize",
    label: "Memory to Wiki Finalize",
    description: "Persist a promotion decision and, only for Wiki-verified approvals, precisely clean the unchanged Hermes backing copies. Idempotent and crash-recoverable.",
    parameters: Type.Object({
      candidate: Candidate,
      decision: Type.Union([Type.Literal("approve"), Type.Literal("reject"), Type.Literal("defer")]),
      wiki_action: Type.Optional(Type.Union([Type.Literal("new"), Type.Literal("supplement"), Type.Literal("existing"), Type.Literal("wiki_wins"), Type.Literal("hermes_wins")])),
      wiki_verification: Type.Optional(Type.Object({
        verified: Type.Boolean(), candidate_id: Type.String(), query: Type.String(), page_ids: Type.Array(Type.String()),
        evidence: Type.Optional(Type.Any()), verified_at: Type.Optional(Type.String()),
      })),
    }),
    async execute(_id, params) {
      const value = await memoryToWikiFinalize(params as FinalizeInput);
      return toolResult(value, !value.ok);
    },
  });

  pi.registerCommand("memory-to-wiki", {
    description: "Review and promote Hermes Memory into LLM Wiki",
    handler: async (raw, ctx) => {
      try {
        const args = parseCommandArgs(raw);
        await ctx.waitForIdle();
        pi.sendUserMessage(orchestrationPrompt(args));
      } catch (error) {
        ctx.ui.notify(`Memory to Wiki: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
