import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectPackageManager, pinOverrides, batchedWithDeps } from "../src/package-manager.mjs";

function scratch({ lockfile, manifest = { name: "x" } }) {
  const root = mkdtempSync(join(tmpdir(), "dep-check-pm-"));
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
  if (lockfile) writeFileSync(join(root, lockfile), "");
  return root;
}

describe("detectPackageManager", () => {
  it("test_reads_the_lockfile_rather_than_the_packageManager_field", () => {
    // theokit-skills, exactly: declares pnpm, ships a package-lock, and its CI runs npm.
    // Trusting the field would run `pnpm install --frozen-lockfile` on a healthy repo.
    const root = scratch({
      lockfile: "package-lock.json",
      manifest: { name: "@theokit/skills", packageManager: "pnpm@10.34.1" },
    });
    expect(detectPackageManager(root).manager).toBe("npm");
  });

  it("test_recognises_a_pnpm_workspace", () => {
    expect(detectPackageManager(scratch({ lockfile: "pnpm-lock.yaml" })).manager).toBe("pnpm");
  });

  it("test_returns_null_rather_than_guessing_when_there_is_no_lockfile", () => {
    expect(detectPackageManager(scratch({ lockfile: null }))).toBeNull();
  });

  it("test_carries_the_run_command_too_not_only_the_install_one", () => {
    // The defect this closes: the gate detected the manager for `install` and for the
    // overrides field, then ran a hardcoded `pnpm test` — which on the one npm repository
    // in the ecosystem produced `pnpm: command not found`, exit 127, in a job whose job
    // name promised it had run the suite. Detecting the manager in two places out of
    // three is indistinguishable from not detecting it at all.
    expect(detectPackageManager(scratch({ lockfile: "package-lock.json" })).run).toEqual(["npm", "run"]);
    expect(detectPackageManager(scratch({ lockfile: "pnpm-lock.yaml" })).run).toEqual(["pnpm", "run"]);
  });
});

describe("pinOverrides", () => {
  it("test_writes_pnpm_overrides_under_the_pnpm_key", () => {
    const root = scratch({ lockfile: "pnpm-lock.yaml" });
    pinOverrides(root, { "@theokit/agents": "11.0.0" });
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(manifest.pnpm.overrides).toEqual({ "@theokit/agents": "11.0.0" });
    expect(manifest.overrides).toBeUndefined();
  });

  it("test_writes_npm_overrides_at_the_top_level", () => {
    // Writing to the wrong field is silently ignored: the reinstall resolves the same
    // versions, the suite passes, and the floor leg reports a bottom it never visited.
    const root = scratch({ lockfile: "package-lock.json" });
    pinOverrides(root, { "@theokit/sdk": "4.0.1" });
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(manifest.overrides).toEqual({ "@theokit/sdk": "4.0.1" });
    expect(manifest.pnpm).toBeUndefined();
  });

  it("test_keeps_overrides_the_repository_already_had", () => {
    const root = scratch({ lockfile: "pnpm-lock.yaml", manifest: { name: "x", pnpm: { overrides: { esbuild: "0.25.0" } } } });
    pinOverrides(root, { "@theokit/sdk": "4.0.1" });
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(manifest.pnpm.overrides).toEqual({ esbuild: "0.25.0", "@theokit/sdk": "4.0.1" });
  });

  it("test_refuses_to_pin_when_it_cannot_tell_which_manager_to_pin_for", () => {
    expect(() => pinOverrides(scratch({ lockfile: null }), { a: "1" })).toThrow(/no lockfile/);
  });
});

describe("batchedWithDeps — one invocation for a leg that claims several packages", () => {
  it("test_pnpm_repeats_the_filter_flag_so_the_task_graph_is_planned_once", () => {
    // Measured on theokit-plugins, whose floor leg claims 10 packages, cold cache, two rounds:
    //
    //   sequential (10 invocations)  35.2s, 39.6s
    //   batched    (1 invocation)    23.4s, 24.0s
    //
    // -34% and -39%. Ten invocations re-plan the graph ten times and rebuild the shared
    // dependencies each round; one invocation plans once and builds each dependency once.
    const pnpm = { file: "pnpm-lock.yaml" };
    expect(batchedWithDeps(pnpm, ["@theokit/a", "@theokit/b"])).toEqual([
      "pnpm", "--filter", "@theokit/a...", "--filter", "@theokit/b...", "run",
    ]);
  });

  it("test_a_single_package_batches_to_the_same_thing_the_loop_would_run", () => {
    const pnpm = { file: "pnpm-lock.yaml" };
    expect(batchedWithDeps(pnpm, ["@theokit/a"])).toEqual(["pnpm", "--filter", "@theokit/a...", "run"]);
  });

  it("test_returns_null_for_a_manager_whose_multi_package_form_was_not_verified", () => {
    // npm has no `...` equivalent at all, and yarn's `yarn workspace <pkg> run` takes exactly one
    // name — batching there needs `workspaces foreach`, a different command with different
    // semantics. Returning null rather than guessing keeps the caller on the loop it already has,
    // which is correct if slower. A wrong batch would silently build the wrong set.
    expect(batchedWithDeps({ file: "package-lock.json" }, ["a", "b"])).toBeNull();
    expect(batchedWithDeps({ file: "yarn.lock" }, ["a", "b"])).toBeNull();
  });

  it("test_an_empty_package_list_is_null_not_a_command_that_builds_everything", () => {
    // `pnpm run build` with no filter builds the WHOLE workspace, which is the defect the
    // per-package filter exists to prevent: packages whose own ranges exclude this floor fail.
    expect(batchedWithDeps({ file: "pnpm-lock.yaml" }, [])).toBeNull();
  });
});
