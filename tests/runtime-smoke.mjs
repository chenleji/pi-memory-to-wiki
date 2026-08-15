import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";
import process from "node:process";

export async function verifyRegistration({ cwd, extensionPath, piRoot = cwd }) {
  const loaderUrl = pathToFileURL(path.join(piRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "extensions", "loader.js")).href;
  const { loadExtensions } = await import(loaderUrl);
  const loaded = await loadExtensions([extensionPath], cwd);
  assert.deepEqual(loaded.errors, [], `Pi loader errors: ${JSON.stringify(loaded.errors)}`);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  assert.deepEqual([...extension.tools.keys()].sort(), ["memory_to_wiki_finalize", "memory_to_wiki_scan"]);
  assert.ok(extension.commands.has("memory-to-wiki"));
  const isolatedAgentRoot = mkdtempSync(path.join(os.tmpdir(), "memory-to-wiki-runtime-"));
  const priorRoot = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = isolatedAgentRoot;
    const registered = extension.tools.get("memory_to_wiki_scan");
    const invoked = await registered.definition.execute(
      "runtime-smoke",
      { scope: "global", limit: 1 },
      new AbortController().signal,
      () => {},
      { cwd, hasUI: false },
    );
    assert.equal(invoked.details.status, "ok");
  } finally {
    if (priorRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorRoot;
    rmSync(isolatedAgentRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const root = process.cwd();
  await verifyRegistration({ cwd: root, extensionPath: path.join(root, "extensions", "pi-memory-to-wiki.ts") });
  console.log("Pi runtime loaded pi-memory-to-wiki and registered 2 tools + 1 command.");
}
