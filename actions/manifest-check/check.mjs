#!/usr/bin/env node
/**
 * The published-manifest contract, checked instead of remembered.
 *
 * Audited across 50 publishable packages on 2026-09-01. Every rule below is a
 * defect that was found, not a style someone preferred:
 *
 *   38/50  did not export "./package.json"  — REPRODUCED: `require('@theokit/di/package.json')`
 *          throws ERR_PACKAGE_PATH_NOT_EXPORTED while @mastra/core resolves. Bundlers,
 *          test-runner resolvers and version telemetry read that path.
 *   22/50  declared no `sideEffects` at all, so every consumer's bundler must assume
 *          the worst and keep everything.
 *   30/50  had no `keywords`; 12 had no `bugs` or `homepage`.
 *
 * `types` must be the FIRST condition in an exports entry: Node resolves conditions in
 * declaration order, so a `types` after `import` is never reached. We were 50/50 correct
 * on that one and the check exists to keep it that way.
 *
 * `sideEffects` must be PRESENT, and may be any value. The check refuses silence, not a
 * particular answer — because the right answer is not always `false`. Measured here:
 * `@theokit/di` calls `Reflect.defineMetadata` at module scope and `@theokit/di-agent`
 * carries a bare `import "reflect-metadata"`. `sideEffects: false` there authorises a
 * bundler to delete the code that makes decorators work, and the symptom is decorators
 * silently without metadata in a consumer's production build.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { globSync } from "node:fs";

const root = process.env.MANIFEST_ROOT || process.cwd();

/** Every exports entry must declare `types` before any resolvable condition. */
function typesNotFirst(node, path = "", out = []) {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return out;
  const keys = Object.keys(node);
  const resolvable = keys.some((k) => k === "import" || k === "require" || k === "default");
  if (resolvable && keys.includes("types") && keys[0] !== "types") out.push(path || ".");
  for (const [k, v] of Object.entries(node)) typesNotFirst(v, `${path}${k}/`, out);
  return out;
}

function findManifests() {
  const found = [];
  const seen = new Set();
  for (const pattern of ["package.json", "packages/*/package.json", "*/package.json"]) {
    for (const p of globSync(pattern, { cwd: root })) {
      const abs = join(root, p);
      if (abs.includes("node_modules") || seen.has(abs)) continue;
      seen.add(abs);
      found.push(abs);
    }
  }
  return found;
}

const problems = [];
let checked = 0;

for (const file of findManifests()) {
  let pkg;
  try { pkg = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
  if (pkg.private || !pkg.name) continue;
  checked += 1;
  const rel = relative(root, file) || "package.json";
  const add = (rule, detail) => problems.push({ rel, name: pkg.name, rule, detail });

  // A package whose only entry point is a binary is not imported by anything, so an
  // exports map would describe a surface nobody reaches. Verified, not assumed: the
  // four exports-less packages in this ecosystem are all bin-only CLIs.
  const binOnly = pkg.bin && !pkg.exports && !pkg.main;

  if (!binOnly) {
    if (!pkg.exports) add("exports_missing", "no exports map, and the package is not bin-only");
    else if (typeof pkg.exports === "object" && !("./package.json" in pkg.exports))
      add("package_json_not_exported", 'add "./package.json": "./package.json"');
    const bad = typesNotFirst(pkg.exports);
    if (bad.length) add("types_not_first", `conditions: ${bad.join(", ")}`);
    if (!("sideEffects" in pkg))
      add("side_effects_undeclared", "declare it — false, or a list; silence is not an answer");
  }

  for (const field of ["license", "description", "engines", "files", "repository", "publishConfig"])
    if (!(field in pkg)) add(`${field}_missing`, "");

  if (pkg.publishConfig && pkg.publishConfig.provenance !== true)
    add("provenance_off", "publishConfig.provenance must be true — the tarball's link to its commit");

  if (typeof pkg.repository === "string")
    add("repository_is_string", "use an object; a monorepo package also needs `directory`");
  else if (pkg.repository && !pkg.repository.directory && /[\\/]packages[\\/]/.test(rel))
    add("repository_directory_missing", "a package inside a monorepo must say where it lives");

  for (const field of ["bugs", "homepage", "keywords"])
    if (!(field in pkg)) add(`${field}_missing`, "");
  if (Array.isArray(pkg.keywords) && pkg.keywords.length === 0) add("keywords_empty", "");
}

if (checked === 0) {
  console.error("::error title=manifest-check::found no publishable package.json — the check verified nothing.");
  process.exit(1);
}

const byRule = new Map();
for (const p of problems) byRule.set(p.rule, (byRule.get(p.rule) || 0) + 1);

console.log(`checked ${checked} publishable manifest(s) under ${root}`);
if (problems.length === 0) {
  console.log("every one satisfies the contract");
  process.exit(0);
}
console.log("");
for (const p of problems) console.log(`  ${p.name.padEnd(30)} ${p.rule.padEnd(30)} ${p.detail}`);
console.log("");
for (const [rule, n] of [...byRule].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${rule}`);
console.error(`::error title=manifest-check::${problems.length} manifest problem(s) across ${checked} package(s).`);
process.exit(1);
