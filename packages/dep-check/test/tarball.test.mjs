import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { installFromTarball } from "../src/tarball.mjs";

/*
 * Check D packs a package and installs the tarball. Which packer produces it is not a detail:
 * `workspace:` is pnpm's protocol and ONLY pnpm rewrites it into a real range while packing.
 *
 * Measured 2026-08-27 against usetheokit/theokit: the gate answered
 *
 *   npm error code EUNSUPPORTEDPROTOCOL
 *   npm error Unsupported URL Type "workspace:": workspace:*
 *
 * for `theokit` and `@theokit/agents`. Packed with npm, the protocol survives verbatim into the
 * tarball's manifest, so installing it can only ever fail — for every package that depends on a
 * sibling. The gate was reporting its own packing step as a dependency defect, and it is a required
 * check, so it blocked a release that had nothing wrong with it.
 */

const scratches = [];
function workspacePackage() {
  const dir = mkdtempSync(join(tmpdir(), "dep-check-fixture-"));
  scratches.push(dir);
  const pkg = join(dir, "packages", "leaf");
  mkdirSync(pkg, { recursive: true });
  // A pnpm workspace, because `pnpm pack` only rewrites the protocol inside one.
  writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "root", private: true }));
  mkdirSync(join(dir, "packages", "sib"), { recursive: true });
  writeFileSync(
    join(dir, "packages", "sib", "package.json"),
    JSON.stringify({ name: "dep-check-fixture-sib", version: "1.0.0" }),
  );
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "dep-check-fixture-leaf",
      version: "1.0.0",
      dependencies: { "dep-check-fixture-sib": "workspace:*" },
    }),
  );
  return pkg;
}

afterAll(() => {
  for (const d of scratches) rmSync(d, { recursive: true, force: true });
});

describe("installFromTarball", () => {
  it("test_does_not_report_a_workspace_protocol_as_a_dependency_defect", () => {
    const result = installFromTarball({ packageDir: workspacePackage() });

    // The sibling is not published, so the install genuinely cannot succeed — that is fine and not
    // what this asserts. What must NOT appear is the protocol itself: seeing `workspace:` in the
    // failure means the tarball carried it, which is the packer's doing and not the package's.
    const surfaced = `${result.reason ?? ""}\n${result.detail ?? ""}`;
    expect(surfaced).not.toMatch(/EUNSUPPORTEDPROTOCOL|Unsupported URL Type "workspace:"/);
  });
});
