import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findPublishablePackages, resolveInstalledVersion, siblingReferences } from "../src/ecosystem.mjs";
import { isSibling } from "../src/checks.mjs";

function scratchRepo() {
  const root = mkdtempSync(join(tmpdir(), "dep-check-"));
  const write = (rel, json) => {
    const dir = join(root, rel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(json));
    return dir;
  };
  return { root, write };
}

describe("findPublishablePackages", () => {
  it("test_skips_the_private_workspace_root_and_keeps_the_published_package", () => {
    const { root, write } = scratchRepo();
    write(".", { name: "some-monorepo", private: true });
    write("packages/sdk", { name: "@theokit/sdk", version: "4.57.0" });
    const found = findPublishablePackages(root);
    expect(found.map((f) => f.manifest.name)).toEqual(["@theokit/sdk"]);
  });

  it("test_keeps_a_single_package_repository_that_publishes_from_its_root", () => {
    // `@theokit/skills` is one package at the repository root, not a workspace.
    const { root, write } = scratchRepo();
    write(".", { name: "@theokit/skills", version: "0.4.2" });
    expect(findPublishablePackages(root).map((f) => f.manifest.name)).toEqual(["@theokit/skills"]);
  });
});

describe("siblingReferences", () => {
  it("test_reports_the_field_each_reference_came_from", () => {
    const refs = siblingReferences(
      {
        dependencies: { "@theokit/agents": "^11.1.0", react: "^19.0.0" },
        peerDependencies: { "@theokit/sdk": ">=4.0.1 <5", vite: ">=6 <9" },
      },
      isSibling,
    );
    expect(refs).toEqual([
      { field: "peerDependencies", dep: "@theokit/sdk", range: ">=4.0.1 <5" },
      { field: "dependencies", dep: "@theokit/agents", range: "^11.1.0" },
    ]);
  });

  it("test_returns_nothing_for_a_manifest_with_no_sibling_at_all", () => {
    expect(siblingReferences({ dependencies: { react: "^19.0.0" } }, isSibling)).toEqual([]);
  });
});

describe("resolveInstalledVersion", () => {
  it("test_reads_the_version_from_the_nearest_node_modules", () => {
    const { root, write } = scratchRepo();
    const pkgDir = write("packages/studio", { name: "@theokit/studio" });
    write("packages/studio/node_modules/@theokit/agents", { name: "@theokit/agents", version: "11.1.0" });
    expect(resolveInstalledVersion(pkgDir, "@theokit/agents")).toBe("11.1.0");
  });

  it("test_walks_up_to_a_hoisted_copy_the_way_node_resolution_does", () => {
    const { root, write } = scratchRepo();
    const pkgDir = write("packages/studio", { name: "@theokit/studio" });
    write("node_modules/@theokit/agents", { name: "@theokit/agents", version: "7.6.0" });
    expect(resolveInstalledVersion(pkgDir, "@theokit/agents")).toBe("7.6.0");
  });

  it("test_returns_null_when_nothing_is_installed_rather_than_guessing", () => {
    const { root, write } = scratchRepo();
    const pkgDir = write("packages/studio", { name: "@theokit/studio" });
    expect(resolveInstalledVersion(pkgDir, "@theokit/sdk")).toBeNull();
  });
});
