/**
 * Check D — install the package as a consumer would, and look at the tree.
 *
 * This is the only check that exercises the artefact rather than the manifest, and
 * it exists because of a specific failure the other three cannot see: the studio
 * defect did not produce an install error. `npm i theokit @theokit/studio` succeeded,
 * installed `@theokit/agents` twice, and hoisted the four-majors-old copy to the root
 * of node_modules where application code resolved it first. Nothing failed; the
 * versions simply disagreed.
 *
 * So this asks two questions, not one:
 *   1. does it install at all (npm's ERESOLVE is a real answer)
 *   2. is there exactly one copy of each ecosystem sibling in the resulting tree
 *
 * A gate that only asks (1) reports green on the worse outcome.
 *
 * ## Pack with the workspace's manager, install with npm
 *
 * These are different tools for different reasons, and using one for both was a real defect: this
 * packed with `npm pack`, which copies `"@theokit/sdk": "workspace:^"` into the tarball VERBATIM.
 * Only pnpm rewrites the workspace protocol at pack time. So every package that depends on a sibling
 * through `workspace:` produced an artefact that could not install anywhere —
 * `EUNSUPPORTEDPROTOCOL` — and the check failed on the packer rather than on the package. Measured
 * on theokit-sdk/packages/acp:
 *
 *     npm  pack -> "@theokit/sdk": "workspace:^"   (unusable)
 *     pnpm pack -> "@theokit/sdk": "^4.58.0"       (what the registry actually receives)
 *
 * The INSTALL stays npm on purpose, which is the original reason and still holds: pnpm has defaulted
 * `strict-peer-dependencies` to false since v8, so a broken peer contract is only a warning there and
 * this gate would pass on a package no npm user can install.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { duplicateSiblingCopies } from "./checks.mjs";
import { detectPackageManager } from "./package-manager.mjs";

function run(cmd, args, cwd) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) {
    return { ok: false, out: (error.stdout ?? "") + (error.stderr ?? "") };
  }
}

const npm = (args, cwd) => run("npm", args, cwd);

/**
 * Pack `packageDir`, install the tarball into an empty project alongside `alsoInstall`,
 * and report what the tree looks like.
 *
 * npm rather than pnpm on purpose. pnpm has defaulted `strict-peer-dependencies` to
 * false since v8, so a broken peer contract is a warning there and the gate would
 * pass on a package no npm user can install. The stricter resolver is the one that
 * tells the truth about the published contract.
 */
export function installFromTarball({ packageDir, repoRoot, alsoInstall = [], localSiblings = [], keep = false }) {
  const scratch = mkdtempSync(join(tmpdir(), "dep-check-install-"));
  try {
    // Detected from the REPOSITORY ROOT, not from the package directory. In a workspace the lockfile
    // lives at the root and `packages/acp` has none, so detecting from the package silently fell
    // back to npm — which packs `workspace:^` verbatim and produces a tarball that installs
    // nowhere. The fallback was doing the exact thing the detection existed to prevent.
    const manager = detectPackageManager(repoRoot ?? packageDir)?.manager ?? "npm";
    const packed = run(manager, ["pack", "--pack-destination", scratch], packageDir);
    if (!packed.ok) return { installed: false, reason: `pack failed (${manager})`, detail: packed.out, duplicates: [] };
    const tarball = readdirSync(scratch).find((f) => f.endsWith(".tgz"));
    if (!tarball) return { installed: false, reason: "pack produced no tarball", detail: packed.out, duplicates: [] };

    // Siblings the registry does not have yet, packed from the workspace and installed as files.
    // Without this, a version pull request that bumps a package and a sibling together can never
    // pass: `pnpm pack` rewrites `workspace:^` to the new local version, and the install asks npm
    // for the version that pull request exists to publish. See `unpublishedSiblings` for why this
    // is narrow — only the gap is filled, never a version the registry already serves.
    const substituted = [];
    for (const sibling of localSiblings) {
      const packedSibling = run(manager, ["pack", "--pack-destination", scratch], sibling.dir);
      if (!packedSibling.ok) {
        return { installed: false, reason: `pack failed for ${sibling.name} (${manager})`, detail: packedSibling.out, duplicates: [], substituted };
      }
      const file = readdirSync(scratch).find((f) => f.endsWith(".tgz") && f !== tarball && !substituted.some((s) => s.file === f));
      if (!file) {
        return { installed: false, reason: `pack produced no tarball for ${sibling.name}`, detail: packedSibling.out, duplicates: [], substituted };
      }
      substituted.push({ ...sibling, file });
    }

    npm(["init", "-y"], scratch);
    const install = npm([
      "install", "--no-audit", "--no-fund",
      join(scratch, tarball),
      ...substituted.map((s) => join(scratch, s.file)),
      ...alsoInstall,
    ], scratch);
    if (!install.ok) {
      const eresolve = /ERESOLVE/.test(install.out);
      return {
        installed: false,
        reason: eresolve ? "ERESOLVE — the declared peers cannot be satisfied together" : "install failed",
        detail: install.out.split("\n").filter((l) => /npm error/.test(l)).slice(0, 12).join("\n"),
        duplicates: [],
        substituted,
      };
    }

    const listed = npm(["ls", "--all", "--json"], scratch);
    // `npm ls` exits non-zero on an imperfect tree while still printing valid JSON,
    // which is precisely the case worth inspecting — so parse the output either way.
    let tree = null;
    try {
      tree = JSON.parse(listed.out);
    } catch {
      return { installed: true, reason: "npm ls produced no readable tree", detail: listed.out.slice(0, 800), duplicates: [], substituted };
    }
    return { installed: true, reason: null, detail: null, duplicates: duplicateSiblingCopies(tree), substituted };
  } finally {
    if (!keep) rmSync(scratch, { recursive: true, force: true });
  }
}
