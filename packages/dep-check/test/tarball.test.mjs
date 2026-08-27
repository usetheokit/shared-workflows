import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectBuildScript, detectPackageManager } from "../src/package-manager.mjs";
import { installFromTarball } from "../src/tarball.mjs";

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

  it("test_never_surfaces_the_workspace_protocol_as_a_dependency_defect", () => {
    // The three tests above pin the DECISION. This one runs the whole path, because the decision
    // being right in isolation is not what broke: `installFromTarball` was asking the package
    // directory rather than the root, and no unit test of `detectPackageManager` could see that.
    //
    // The sibling here is unpublished, so the install genuinely cannot succeed — that is fine and
    // not what this asserts. What must never appear is the protocol itself. `workspace:` reaching
    // the install means the tarball carried it, which is the packer's doing and not the package's.
    const { root, pkg } = workspace();

    const result = installFromTarball({ packageDir: pkg, repoRoot: root });

    const surfaced = `${result.reason ?? ""}\n${result.detail ?? ""}`;
    expect(surfaced).not.toMatch(/EUNSUPPORTEDPROTOCOL|Unsupported URL Type "workspace:"/);
  });
});

/**
 * The floor leg reinstalls at the bottom of every declared range and then runs the suite.
 * It did not build in between, so it ran against a tree with no `dist/` — an arrangement
 * no CI here produces. `theokit-tui` failed its publish-contract test on `publint
 * --strict`, and `theokit` reported `SKIP: dist/index.js not found (run pnpm build
 * first)`. Neither failure was about a range.
 */
describe("whether the repository builds before its tests", () => {
  function repoWith(scripts) {
    const root = mkdtempSync(join(tmpdir(), "dep-check-build-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "r", scripts }));
    return root;
  }

  it("test_finds_the_build_script_a_repository_runs_before_testing", () => {
    expect(detectBuildScript(repoWith({ build: "tsc", test: "vitest run" }))).toBe("build");
  });

  it("test_prefers_build_over_build_packages_when_a_repository_has_both", () => {
    // `theokit` has both. `build` is the one that produces everything a consumer sees.
    expect(detectBuildScript(repoWith({ build: "turbo build", "build:packages": "turbo build --filter=./packages/*" }))).toBe("build");
  });

  it("test_falls_back_to_build_packages_when_that_is_the_only_one", () => {
    expect(detectBuildScript(repoWith({ "build:packages": "turbo build" }))).toBe("build:packages");
  });

  it("test_returns_null_for_a_repository_with_no_build_so_the_step_is_skipped_not_failed", () => {
    // A repository that does not build must not have the leg fail on a missing script.
    expect(detectBuildScript(repoWith({ test: "vitest run" }))).toBeNull();
  });
});

/**
 * The per-package floor leg installs one sibling at ONE package's declared floor and must run only
 * that package's suite — running the whole workspace against a floor only one package claims would
 * fail packages whose own ranges exclude it, which is the defect #4 was.
 */
describe("running a suite filtered to one package", () => {
  function repo(lockfile) {
    const root = mkdtempSync(join(tmpdir(), "dep-check-filter-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "r", scripts: { test: "vitest run" } }));
    writeFileSync(join(root, lockfile), lockfile.endsWith(".json") ? "{}" : "lockfileVersion: '9.0'\n");
    return root;
  }

  it("test_pnpm_filters_with_its_own_flag", () => {
    const m = detectPackageManager(repo("pnpm-lock.yaml"));
    expect(m.filtered("@scope/pkg")).toEqual(["pnpm", "--filter", "@scope/pkg", "run"]);
  });

  it("test_npm_filters_with_workspace_rather_than_pnpms_flag", () => {
    // `npm --filter` is not a thing. Getting this wrong fails with a usage error that reads like
    // a dependency problem — the same shape as the `pnpm: command not found` this file already
    // guards against.
    const m = detectPackageManager(repo("package-lock.json"));
    expect(m.filtered("@scope/pkg")).toEqual(["npm", "run", "--workspace", "@scope/pkg"]);
  });

  it("test_yarn_filters_with_workspace_before_run", () => {
    const m = detectPackageManager(repo("yarn.lock"));
    expect(m.filtered("@scope/pkg")).toEqual(["yarn", "workspace", "@scope/pkg", "run"]);
  });

  it("test_every_manager_can_filter_so_the_leg_never_falls_back_to_the_whole_workspace", () => {
    for (const lock of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]) {
      expect(typeof detectPackageManager(repo(lock)).filtered).toBe("function");
    }
  });
});

describe("building filtered to one package and its dependencies", () => {
  function repo(lockfile) {
    const root = mkdtempSync(join(tmpdir(), "dep-check-bfilter-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "r", scripts: { build: "turbo build" } }));
    writeFileSync(join(root, lockfile), lockfile.endsWith(".json") ? "{}" : "lockfileVersion: '9.0'\n");
    return root;
  }

  it("test_pnpm_includes_the_packages_dependencies_with_the_ellipsis", () => {
    // `--filter pkg` alone builds pkg without its workspace dependencies, and the build fails on
    // the missing dist/ of a sibling. `pkg...` is pnpm's way of saying "and what it needs".
    const m = detectPackageManager(repo("pnpm-lock.yaml"));
    expect(m.filteredWithDeps("@scope/pkg")).toEqual(["pnpm", "--filter", "@scope/pkg...", "run"]);
  });

  it("test_the_build_filter_is_not_the_same_as_the_test_filter", () => {
    // Tests run for one package only; the build must also produce what that package imports.
    const m = detectPackageManager(repo("pnpm-lock.yaml"));
    expect(m.filteredWithDeps("p")).not.toEqual(m.filtered("p"));
  });

  it("test_every_manager_answers_so_the_leg_never_silently_builds_the_whole_workspace", () => {
    // npm and yarn have no dependency-closure filter; using the plain workspace filter is the
    // honest approximation, and the assertion is that a filter exists at all — building
    // everything at a floor one package claims is what this exists to avoid.
    for (const lock of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]) {
      expect(typeof detectPackageManager(repo(lock)).filteredWithDeps).toBe("function");
    }
  });
});
