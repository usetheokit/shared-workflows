import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectPackageManager } from "../src/package-manager.mjs";

/**
 * The packer choice, which is the one decision in `installFromTarball` that can be wrong silently.
 *
 * `npm pack` copies `"@theokit/sdk": "workspace:^"` into the tarball verbatim; only pnpm rewrites the
 * workspace protocol at pack time. Packing a workspace member with npm therefore produces an artefact
 * that installs NOWHERE — `EUNSUPPORTEDPROTOCOL` — and the check fails on the packer rather than on
 * the package. Measured on theokit-sdk/packages/acp:
 *
 *     npm  pack -> "@theokit/sdk": "workspace:^"
 *     pnpm pack -> "@theokit/sdk": "^4.58.0"
 *
 * The bug that made this test necessary was not the choice itself but WHERE it looked: detection ran
 * against the package directory, and in a workspace the lockfile lives at the root, so
 * `packages/acp` has none and the code fell back to npm — the exact thing the detection existed to
 * avoid. A fallback that lands on the failure mode is worse than no fallback.
 */
describe("which packer a workspace member gets", () => {
  function workspace() {
    const root = mkdtempSync(join(tmpdir(), "dep-check-ws-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", private: true }));
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    const pkg = join(root, "packages", "member");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({
      name: "@scope/member",
      version: "1.0.0",
      peerDependencies: { "@scope/core": "workspace:^" },
    }));
    return { root, pkg };
  }

  it("test_the_package_directory_alone_cannot_answer_which_manager_packs", () => {
    // The lockfile is at the ROOT. Asking the member directory returns null, and a `?? "npm"`
    // fallback on that answer is how `workspace:^` reached a tarball.
    const { pkg } = workspace();
    expect(detectPackageManager(pkg)).toBeNull();
  });

  it("test_the_repository_root_answers_pnpm_for_a_pnpm_workspace", () => {
    const { root } = workspace();
    expect(detectPackageManager(root).manager).toBe("pnpm");
  });

  it("test_an_npm_repository_still_answers_npm", () => {
    // Not every repository is a pnpm workspace — @theokit/skills is on npm, and there `npm pack` is
    // both correct and the only option. The fix must not hardcode pnpm.
    const root = mkdtempSync(join(tmpdir(), "dep-check-npm-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "solo", version: "1.0.0" }));
    writeFileSync(join(root, "package-lock.json"), "{}");
    expect(detectPackageManager(root).manager).toBe("npm");
  });
});
