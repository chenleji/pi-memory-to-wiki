import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyRegistration } from "./runtime-smoke.mjs";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const archive = path.join(root, `${pkg.name}-${pkg.version}.tgz`);
const target = mkdtempSync(path.join(os.tmpdir(), "pi-memory-to-wiki-package-"));
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 180_000 });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
}
try {
  rmSync(archive, { force: true });
  run("npm", ["pack", "--ignore-scripts"], root);
  mkdirSync(path.join(target, "app"));
  writeFileSync(path.join(target, "app", "package.json"), JSON.stringify({ name: "smoke", private: true }));
  run("npm", ["install", "--legacy-peer-deps", archive], path.join(target, "app"));
  const installed = path.join(target, "app", "node_modules", pkg.name);
  await verifyRegistration({ cwd: path.join(target, "app"), piRoot: root, extensionPath: path.join(installed, "extensions", "pi-memory-to-wiki.ts") });
  const installedPkg = JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8"));
  assert.deepEqual(installedPkg.pi.extensions, ["./extensions/pi-memory-to-wiki.ts"]);
  console.log("Packed npm artifact installed cleanly and loaded in the real Pi extension runtime.");
} finally {
  rmSync(archive, { force: true });
  rmSync(target, { recursive: true, force: true });
}
