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
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { duplicateSiblingCopies } from "./checks.mjs";

function pnpm(args, cwd) {
  try {
    return { ok: true, out: execFileSync("pnpm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function npm(args, cwd) {
  try {
    return { ok: true, out: execFileSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) {
    return { ok: false, out: (error.stdout ?? "") + (error.stderr ?? "") };
  }
}

/**
 * Pack `packageDir`, install the tarball into an empty project alongside `alsoInstall`,
 * and report what the tree looks like.
 *
 * PACK with pnpm, INSTALL with npm. The two halves have different reasons and neither
 * is interchangeable.
 *
 * npm for the install, because pnpm has defaulted `strict-peer-dependencies` to false
 * since v8: a broken peer contract is a warning there, and the gate would pass on a
 * package no npm user can install. The stricter resolver is the one that tells the
 * truth about the published contract.
 *
 * pnpm for the pack, because `workspace:` is pnpm's protocol and only pnpm rewrites it
 * into a real range while packing. Packed with npm, `workspace:*` survives verbatim into
 * the tarball's manifest and the install can only ever fail — EUNSUPPORTEDPROTOCOL, for
 * every package that depends on a sibling. Measured 2026-08-27 against usetheokit/theokit,
 * where this gate is required and blocked a release whose packages were fine. The artifact
 * has to be the one a real publish would produce, and here that means pnpm's.
 */
export function installFromTarball({ packageDir, alsoInstall = [], keep = false }) {
  const scratch = mkdtempSync(join(tmpdir(), "dep-check-install-"));
  try {
    const packed = pnpm(["pack", "--pack-destination", scratch], packageDir);
    if (!packed.ok) return { installed: false, reason: "pack failed", detail: packed.out, duplicates: [] };
    const tarball = readdirSync(scratch).find((f) => f.endsWith(".tgz"));
    if (!tarball) return { installed: false, reason: "pack produced no tarball", detail: packed.out, duplicates: [] };

    npm(["init", "-y"], scratch);
    const install = npm(["install", "--no-audit", "--no-fund", join(scratch, tarball), ...alsoInstall], scratch);
    if (!install.ok) {
      const eresolve = /ERESOLVE/.test(install.out);
      return {
        installed: false,
        reason: eresolve ? "ERESOLVE — the declared peers cannot be satisfied together" : "install failed",
        detail: install.out.split("\n").filter((l) => /npm error/.test(l)).slice(0, 12).join("\n"),
        duplicates: [],
      };
    }

    const listed = npm(["ls", "--all", "--json"], scratch);
    // `npm ls` exits non-zero on an imperfect tree while still printing valid JSON,
    // which is precisely the case worth inspecting — so parse the output either way.
    let tree = null;
    try {
      tree = JSON.parse(listed.out);
    } catch {
      return { installed: true, reason: "npm ls produced no readable tree", detail: listed.out.slice(0, 800), duplicates: [] };
    }
    return { installed: true, reason: null, detail: null, duplicates: duplicateSiblingCopies(tree) };
  } finally {
    if (!keep) rmSync(scratch, { recursive: true, force: true });
  }
}
