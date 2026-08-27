import { describe, expect, it } from "vitest";
import {
  ceilingDrift,
  consumersLeftBehind,
  duplicateSiblingCopies,
  installedDrift,
  isSibling,
  rangeFloor,
  sharedFloor,
  unpublishedSiblings,
  untestedFloors,
} from "../src/checks.mjs";

describe("isSibling", () => {
  it("test_recognises_the_scoped_packages_and_the_bare_framework", () => {
    expect(isSibling("@theokit/sdk")).toBe(true);
    expect(isSibling("theokit")).toBe(true);
  });

  it("test_does_not_claim_unrelated_packages_that_merely_start_with_theo", () => {
    // `theokit-studio` is a repository name, never a package name. Matching on a
    // prefix rather than the exact scope would drag third-party packages in.
    expect(isSibling("theokit-studio")).toBe(false);
    expect(isSibling("@theocode/cli")).toBe(false);
    expect(isSibling("vite")).toBe(false);
  });
});

describe("ceilingDrift — check C: does the declared range still admit the published latest?", () => {
  // The three historical states this gate exists for. If it cannot flag these, it is a
  // probe that cannot detect the condition it screens for, and green means nothing.
  it("test_flags_the_di_agent_range_that_shipped_broken", () => {
    expect(ceilingDrift({ range: "^1.3.0", latest: "4.57.0" })).toMatchObject({ majorsBehind: 3 });
  });

  it("test_flags_the_studio_range_that_shipped_a_second_runtime_copy", () => {
    expect(ceilingDrift({ range: "^7.6.0", latest: "11.1.0" })).toMatchObject({ majorsBehind: 4 });
  });

  it("test_flags_the_studio_range_that_0_2_0_already_corrected_by_hand_once", () => {
    // The whole argument for automating this: the same range was fixed manually in
    // 0.2.0 and went stale again. A gate that only knows about today's drift would
    // have let the first one through too.
    expect(ceilingDrift({ range: "^0.39.0", latest: "11.1.0" })).toBeTruthy();
  });

  it("test_is_silent_on_the_corrected_ranges", () => {
    expect(ceilingDrift({ range: ">=4.0.1 <5", latest: "4.57.0" })).toBeNull();
    expect(ceilingDrift({ range: ">=11.0.0 <12", latest: "11.1.0" })).toBeNull();
  });

  it("test_counts_a_zero_x_minor_as_a_major_because_semver_says_it_is_one", () => {
    // In 0.x the caret pins the minor, so ^0.26.1 does not admit 0.27.1. Reporting
    // that as "0 majors behind" would read as harmless when it is a hard exclusion.
    const drift = ceilingDrift({ range: "^0.26.1", latest: "0.27.1" });
    expect(drift).toBeTruthy();
    expect(drift.majorsBehind).toBe(1);
  });

  it("test_ignores_workspace_protocol_ranges_which_no_registry_can_answer", () => {
    expect(ceilingDrift({ range: "workspace:^", latest: "4.57.0" })).toBeNull();
    expect(ceilingDrift({ range: "workspace:*", latest: "4.57.0" })).toBeNull();
  });

  it("test_does_not_flag_a_prerelease_latest_against_a_stable_range", () => {
    // A `next` tag reaching `latest` briefly is not a reason to open a pull request
    // against every consumer in the organisation.
    expect(ceilingDrift({ range: ">=4.0.1 <5", latest: "5.0.0-next.1" })).toBeNull();
  });
});

describe("installedDrift — check A: does the range admit what the lockfile actually installs?", () => {
  it("test_flags_a_range_that_excludes_the_version_the_suite_runs_against", () => {
    // The offline half. It cannot see the two historical bugs — both were internally
    // coherent — but it catches the inverse mistake: tightening a range under a
    // lockfile that still resolves something else.
    expect(installedDrift({ range: ">=11.0.0 <12", installed: "7.6.0" })).toBeTruthy();
  });

  it("test_is_silent_when_the_installed_version_satisfies_the_range", () => {
    expect(installedDrift({ range: ">=4.0.1 <5", installed: "4.57.0" })).toBeNull();
  });

  it("test_is_silent_when_nothing_is_installed_because_absence_is_not_drift", () => {
    // An optional peer that the repository does not install is not a defect. Saying
    // otherwise would make the gate fire on every consumer of an optional peer.
    expect(installedDrift({ range: ">=4.0.1 <5", installed: null })).toBeNull();
  });
});

describe("rangeFloor — check B: which published version is the bottom of the range?", () => {
  const published = ["4.0.1", "4.0.2", "4.1.0", "4.19.3", "4.57.0", "5.0.0-next.1"];

  it("test_returns_the_lowest_published_version_the_range_admits", () => {
    expect(rangeFloor(">=4.0.1 <5", published)).toBe("4.0.1");
    expect(rangeFloor(">=4.1.0 <5", published)).toBe("4.1.0");
  });

  it("test_returns_the_lowest_real_version_not_the_theoretical_one", () => {
    // `>=4.0.0` admits 4.0.0, which was never published. Testing against a version
    // that does not exist fails on resolution and looks like a version failure.
    expect(rangeFloor(">=4.0.0 <5", published)).toBe("4.0.1");
  });

  it("test_skips_prereleases_so_the_floor_leg_does_not_run_on_a_next_tag", () => {
    expect(rangeFloor(">=5.0.0", published)).toBeNull();
  });
});

describe("unpublishedSiblings — what check D cannot get from the registry yet", () => {
  // A version pull request bumps a package and a sibling it depends on in the same cut.
  // `pnpm pack` rewrites `workspace:^` to the NEW local version, correctly, and the registry
  // does not have it yet — the version this very pull request exists to publish. Measured on
  // usetheokit/theokit#524: theokit@0.57.0 asking for @theokit/agents@^12.1.0 while npm had
  // 12.0.0, answering ETARGET. Any monorepo publishing two interdependent packages together
  // hits it, every time.
  const workspace = [
    { name: "@theokit/agents", version: "12.1.0", dir: "/w/packages/agents" },
    { name: "@theokit/ui", version: "1.3.2", dir: "/w/packages/ui" },
  ];
  const published = { "@theokit/agents": ["11.1.0", "12.0.0"], "@theokit/ui": ["1.3.0", "1.3.2"] };

  it("test_names_the_sibling_whose_local_version_the_registry_does_not_have", () => {
    const out = unpublishedSiblings({ references: [{ dep: "@theokit/agents" }], workspace, published });
    expect(out.map((s) => s.name)).toEqual(["@theokit/agents"]);
    expect(out[0].version).toBe("12.1.0");
  });

  it("test_leaves_a_sibling_the_registry_already_has_to_be_installed_from_the_registry", () => {
    // Substituting a local tarball for a version that IS published would quietly stop testing
    // what a consumer actually resolves. Only the gap gets the local artifact.
    expect(unpublishedSiblings({ references: [{ dep: "@theokit/ui" }], workspace, published })).toEqual([]);
  });

  it("test_ignores_a_dependency_that_is_not_a_workspace_package_at_all", () => {
    // A genuinely missing dependency must still fail the install. That is the case check D
    // exists to catch, and it is indistinguishable from outside if this swallows it.
    expect(unpublishedSiblings({ references: [{ dep: "@theokit/nowhere" }], workspace, published })).toEqual([]);
  });

  it("test_follows_a_substituted_tarballs_own_unpublished_asks", () => {
    // `@theokit/tauri` depends on `theokit@0.57.0`, which is substituted — and that tarball then
    // requests `@theokit/agents@^12.1.0`, still absent. Substituting only the direct reference
    // moves the ETARGET one level down. Measured: this is what @theokit/tauri failed on.
    const deep = [
      { name: "theokit", version: "0.57.0", dir: "/w/packages/theo", references: [{ dep: "@theokit/agents" }] },
      { name: "@theokit/agents", version: "12.1.0", dir: "/w/packages/agents" },
    ];
    const pub = { theokit: ["0.56.0"], "@theokit/agents": ["12.0.0"] };
    const out = unpublishedSiblings({ references: [{ dep: "theokit" }], workspace: deep, published: pub });
    expect(out.map((s) => s.name).sort()).toEqual(["@theokit/agents", "theokit"]);
  });

  it("test_returns_nothing_when_the_registry_answer_is_missing_rather_than_empty", () => {
    // No packument is not the same as no versions. Treating an unreachable registry as "nothing
    // is published" would substitute local tarballs for every sibling and test nothing real.
    expect(unpublishedSiblings({ references: [{ dep: "@theokit/agents" }], workspace, published: {} })).toEqual([]);
  });
});

describe("sharedFloor — the floor a workspace can actually install", () => {
  const published = ["0.1.0", "0.1.1", "0.2.0"];

  it("test_returns_the_lowest_version_every_declared_range_admits", () => {
    // Two packages in one workspace, two different ranges for the same sibling. The
    // override is a single global value, so the only honest floor is one BOTH accept.
    expect(sharedFloor([">=0.1.1 <0.3", "^0.2.0"], published)).toBe("0.2.0");
  });

  it("test_never_pins_below_a_declared_range_just_because_a_sibling_allows_it", () => {
    // The defect this replaced: taking the lowest INDIVIDUAL floor pinned 0.1.1 —
    // outside `^0.2.0` — and ran the suite on a combination no installer would resolve.
    // The red it produced was about the gate, not about the packages.
    expect(sharedFloor([">=0.1.1 <0.3", "^0.2.0"], published)).not.toBe("0.1.1");
  });

  it("test_a_single_range_behaves_exactly_as_the_single_range_floor", () => {
    expect(sharedFloor(["^0.1.0 || ^0.2.0"], published)).toBe(rangeFloor("^0.1.0 || ^0.2.0", published));
  });

  it("test_ignores_workspace_protocol_ranges_which_pin_nothing", () => {
    expect(sharedFloor(["workspace:*", "^0.2.0"], published)).toBe("0.2.0");
  });

  it("test_returns_null_when_the_declared_ranges_share_no_published_version", () => {
    // Mutually exclusive ranges in one workspace are a real defect, but the floor leg
    // is not the place to pick a winner. Returning null lets the caller report it as
    // what it is instead of silently testing one side.
    expect(sharedFloor(["^0.1.0", "^0.2.0"], published)).toBeNull();
  });
});

describe("consumersLeftBehind — the reverse check, run by the publisher before a major", () => {
  const consumers = [
    { pkg: "@theokit/studio", repo: "theokit-studio", range: ">=11.0.0 <12" },
    { pkg: "theokit", repo: "theokit", range: "^11.1.0" },
    { pkg: "@theocode/agent", repo: "usetheo-labs", range: ">=11.0.0 <13" },
  ];

  it("test_names_who_breaks_when_the_next_major_is_published", () => {
    const left = consumersLeftBehind({ consumers, nextVersion: "12.0.0" });
    expect(left.map((c) => c.pkg).sort()).toEqual(["@theokit/studio", "theokit"]);
  });

  it("test_is_empty_for_a_patch_nobody_excludes", () => {
    expect(consumersLeftBehind({ consumers, nextVersion: "11.1.1" })).toEqual([]);
  });

  it("test_labels_a_consumer_that_already_requires_something_newer_as_ahead_not_behind", () => {
    // Seen for real: `theokit@0.56.0` shipped requiring `@theokit/agents: ^12.0.0`
    // while the checkout still held 11.1.0. That consumer is not stranded by the
    // release — the checkout is behind the registry. Calling both "left behind" would
    // put a finding in the publisher's release with nothing for them to do about it.
    const ahead = [{ pkg: "theokit", repo: "theokit", range: "^12.0.0" }];
    const found = consumersLeftBehind({ consumers: ahead, nextVersion: "11.1.0" });
    expect(found).toHaveLength(1);
    expect(found[0].direction).toBe("ahead");
  });

  it("test_labels_a_genuinely_stranded_consumer_as_behind", () => {
    const stranded = [{ pkg: "@theokit/studio", repo: "theokit-studio", range: "^7.6.0" }];
    expect(consumersLeftBehind({ consumers: stranded, nextVersion: "12.0.0" })[0].direction).toBe("behind");
  });

  it("test_can_be_asked_for_the_stranded_ones_only", () => {
    const mixed = [
      { pkg: "old", range: "^7.6.0" },
      { pkg: "new", range: "^12.0.0" },
    ];
    const found = consumersLeftBehind({ consumers: mixed, nextVersion: "11.1.0", direction: "behind" });
    expect(found.map((c) => c.pkg)).toEqual(["old"]);
  });
});

describe("duplicateSiblingCopies — check D: one runtime, or two?", () => {
  it("test_finds_the_second_copy_that_npm_installed_without_complaining", () => {
    // The studio defect exactly: `npm i theokit @theokit/studio` succeeded and put
    // two runtimes in the tree. A gate that only asks "did the install fail?" is
    // green here, which is why this check asks a different question.
    const tree = {
      dependencies: {
        "@theokit/studio": { version: "0.2.0", dependencies: { "@theokit/agents": { version: "7.6.0" } } },
        theokit: { version: "0.55.0", dependencies: { "@theokit/agents": { version: "11.1.0" } } },
      },
    };
    const dupes = duplicateSiblingCopies(tree);
    expect(dupes).toHaveLength(1);
    expect(dupes[0]).toMatchObject({ dep: "@theokit/agents", versions: ["7.6.0", "11.1.0"] });
  });

  it("test_is_silent_on_a_tree_with_one_copy_of_each_sibling", () => {
    const tree = {
      dependencies: {
        theokit: { version: "0.55.0", dependencies: { "@theokit/agents": { version: "11.1.0" } } },
        "@theokit/studio": { version: "0.3.0" },
      },
    };
    expect(duplicateSiblingCopies(tree)).toEqual([]);
  });

  it("test_ignores_duplicate_copies_of_packages_outside_the_ecosystem", () => {
    // Two copies of `semver` in a tree is ordinary npm. This gate is about the
    // ecosystem's own runtime being loaded twice, not about tree hygiene at large.
    const tree = {
      dependencies: {
        a: { version: "1.0.0", dependencies: { semver: { version: "6.0.0" } } },
        b: { version: "1.0.0", dependencies: { semver: { version: "7.0.0" } } },
      },
    };
    expect(duplicateSiblingCopies(tree)).toEqual([]);
  });
});

describe("untestedFloors — which declared floors the intersection floor never installs", () => {
  const published = ["0.1.0", "0.1.1", "0.2.0"];

  it("test_names_the_package_whose_own_floor_is_below_the_pinned_one", () => {
    // The measured case (usetheokit/theokit-di): the intersection is 0.2.0, so
    // `@theokit/di-agent`'s promise about 0.1.1 stops being verified by anything.
    const declarations = [
      { pkg: "@theokit/di-agent", range: ">=0.1.1 <0.3" },
      { pkg: "@theokit/orm", range: "^0.2.0" },
    ];
    expect(untestedFloors({ declarations, pinned: "0.2.0", publishedVersions: published })).toEqual([
      { pkg: "@theokit/di-agent", range: ">=0.1.1 <0.3", claims: "0.1.1", tested: "0.2.0" },
    ]);
  });

  it("test_says_nothing_when_every_declared_floor_is_the_pinned_one", () => {
    // Agreement is the common case and must stay silent — a note that fires on every
    // repository is a note nobody reads by the third one.
    const declarations = [
      { pkg: "@theokit/orm", range: "^0.2.0" },
      { pkg: "@theokit/di-agent", range: "^0.2.0" },
    ];
    expect(untestedFloors({ declarations, pinned: "0.2.0", publishedVersions: published })).toEqual([]);
  });

  it("test_ignores_a_range_that_admits_nothing_published", () => {
    // `^9.0.0` against a package that never reached 9 has no floor to leave untested.
    // It IS a defect, and it is reported by the check that owns it — repeating it here
    // as "untested floor" would name the wrong problem.
    const declarations = [{ pkg: "@theokit/ghost", range: "^9.0.0" }];
    expect(untestedFloors({ declarations, pinned: "0.2.0", publishedVersions: published })).toEqual([]);
  });

  it("test_reports_nothing_when_no_version_was_pinned_at_all", () => {
    // Ranges sharing no published version are skipped by `sharedFloor` rather than
    // pinned. With nothing installed there is no floor to be below.
    const declarations = [{ pkg: "@theokit/di-agent", range: ">=0.1.1 <0.3" }];
    expect(untestedFloors({ declarations, pinned: null, publishedVersions: published })).toEqual([]);
  });

  it("test_a_package_declaring_a_HIGHER_floor_is_not_a_finding", () => {
    // Its floor is the one being tested, or above it — either way the promise it makes
    // is not the one going unverified.
    const declarations = [{ pkg: "@theokit/orm", range: "^0.2.0" }];
    expect(untestedFloors({ declarations, pinned: "0.1.1", publishedVersions: published })).toEqual([]);
  });
});
