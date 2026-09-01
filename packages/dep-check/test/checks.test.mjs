import { describe, expect, it } from "vitest";
import {
  ceilingDrift,
  consumersLeftBehind,
  duplicateSiblingCopies,
  installedDrift,
  isSibling,
  rangeFloor,
  groupUntestedFloors,
  pinnableSiblings,
  sharedFloor,
  peerInstallSpecs,
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

describe("pinnableSiblings — a workspace member is not something to pin from the registry", () => {
  // Measured on usetheokit/theokit#526. `@theokit/http` lives in that workspace at packages/http,
  // and `pin-floors` replaced the local link with `0.4.0` from the registry — the floor of the
  // `>=0.1.0-alpha.0` that `@theokit/agents` declares. `packages/theo` then failed to build:
  //
  //   error TS2724: '"@theokit/http"' has no exported member named 'createDecoratorHandler'
  //
  // Nobody anywhere has that combination. In development the workspace link is used; published,
  // `workspace:^` is rewritten to the CURRENT local version, never an old one. The declared range
  // is a promise to outside consumers, and the check that tests it is D — install the tarball as
  // a consumer would — not an override that overwrites a sibling with its own past.
  const published = { "@theokit/http": ["0.4.0", "1.0.0"], "@theokit/ui": ["1.1.0", "1.3.2"] };

  it("test_does_not_pin_a_sibling_that_lives_in_this_workspace", () => {
    const members = ["@theokit/http"];
    expect(pinnableSiblings([{ dep: "@theokit/http", range: ">=0.1.0-alpha.0" }], members)).toEqual([]);
  });

  it("test_still_pins_a_sibling_that_only_comes_from_the_registry", () => {
    // `@theokit/ui` is declared by this repository and built elsewhere. Its floor is exactly what
    // the leg exists to exercise.
    const out = pinnableSiblings([{ dep: "@theokit/ui", range: ">=1.1.0" }], ["@theokit/http"]);
    expect(out.map((r) => r.dep)).toEqual(["@theokit/ui"]);
  });

  it("test_keeps_the_external_ones_when_both_kinds_are_declared", () => {
    const out = pinnableSiblings(
      [{ dep: "@theokit/http", range: ">=0.1.0" }, { dep: "@theokit/ui", range: ">=1.1.0" }],
      ["@theokit/http"],
    );
    expect(out.map((r) => r.dep)).toEqual(["@theokit/ui"]);
  });

  it("test_an_empty_workspace_list_pins_everything_rather_than_nothing", () => {
    // A repository with no publishable members must not silently stop pinning. Failing open here
    // would turn the floor leg into a no-op with no signal that it had.
    const out = pinnableSiblings([{ dep: "@theokit/ui", range: ">=1.1.0" }], []);
    expect(out.map((r) => r.dep)).toEqual(["@theokit/ui"]);
  });
});

describe("groupUntestedFloors — the extra runs needed to exercise what the intersection cannot", () => {
  it("test_groups_packages_that_share_the_same_unexercised_floor_into_one_run", () => {
    // `theokit-plugins` has fourteen packages declaring `theokit >=0.50.1`. Fourteen separate
    // installs of the same version would cost fourteen times as much and prove one thing.
    const grouped = groupUntestedFloors([
      { dep: "theokit", pkg: "@theokit/plugin-a", range: ">=0.50.1", claims: "0.50.1", tested: "0.52.1" },
      { dep: "theokit", pkg: "@theokit/plugin-b", range: ">=0.50.1", claims: "0.50.1", tested: "0.52.1" },
    ]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ dep: "theokit", version: "0.50.1" });
    expect(grouped[0].packages).toEqual(["@theokit/plugin-a", "@theokit/plugin-b"]);
  });

  it("test_keeps_distinct_floors_of_the_same_sibling_apart_ordered_by_semver_not_string", () => {
    // Two floors of one sibling are two different claims and need two different installs.
    //
    // The order is semver, and these two versions are the case where that differs from sorting
    // strings: 4.4.1 precedes 4.19.3 by version and follows it alphabetically. A matrix sorted
    // the wrong way is not wrong in any visible way — which is why the assertion names it.
    const grouped = groupUntestedFloors([
      { dep: "@theokit/sdk", pkg: "@theokit/sdk-pty", range: ">=4.4.1", claims: "4.4.1", tested: "4.54.0" },
      { dep: "@theokit/sdk", pkg: "@theokit/sdk-tools", range: ">=4.19.3", claims: "4.19.3", tested: "4.54.0" },
    ]);
    expect(grouped.map((g) => g.version)).toEqual(["4.4.1", "4.19.3"]);
    expect(["4.4.1", "4.19.3"].slice().sort()).toEqual(["4.19.3", "4.4.1"]); // what a string sort gives
  });

  it("test_orders_runs_deterministically_so_a_matrix_does_not_reshuffle_between_runs", () => {
    // A matrix whose entries move between runs makes one failing job impossible to compare
    // against the same job yesterday.
    const input = [
      { dep: "zeta", pkg: "p2", range: ">=2.0.0", claims: "2.0.0", tested: "3.0.0" },
      { dep: "alpha", pkg: "p1", range: ">=1.0.0", claims: "1.0.0", tested: "3.0.0" },
    ];
    const a = groupUntestedFloors(input).map((g) => `${g.dep}@${g.version}`);
    const b = groupUntestedFloors([...input].reverse()).map((g) => `${g.dep}@${g.version}`);
    expect(a).toEqual(b);
    expect(a).toEqual(["alpha@1.0.0", "zeta@2.0.0"]);
  });

  it("test_returns_nothing_when_every_declared_floor_is_already_exercised", () => {
    expect(groupUntestedFloors([])).toEqual([]);
  });
});

describe("ceilingDrift — a range ahead of the registry is not a range behind it", () => {
  // A two-release change declares the new floor before the version exists: the satellite says
  // `>=4.60.0` while the registry is at `4.59.0`. That is a real, temporary state — the package
  // cannot be installed by anyone until the SDK publishes — and the gate should say so.
  //
  // It did say something, and it said the opposite: `0 majors behind`, for a range that is ahead.
  // The measurement was right and the label described its mirror image.

  it("test_reports_a_range_the_registry_cannot_satisfy_yet_as_ahead", () => {
    const drift = ceilingDrift({ range: ">=4.60.0", latest: "4.59.0" });
    expect(drift).toBeTruthy();
    expect(drift.direction).toBe("ahead");
  });

  it("test_still_reports_an_ordinary_stale_range_as_behind", () => {
    const drift = ceilingDrift({ range: "^3.0.0", latest: "4.59.0" });
    expect(drift.direction).toBe("behind");
    expect(drift.majorsBehind).toBe(1);
  });

  it("test_says_nothing_when_the_range_admits_latest", () => {
    expect(ceilingDrift({ range: ">=4.0.0", latest: "4.59.0" })).toBeNull();
  });

  it("test_an_ahead_range_does_not_claim_a_majors_behind_count", () => {
    // `0 majors behind` on a range that is ahead is the label that made this worth fixing:
    // a reader scanning the column sees a number that says "up to date, roughly".
    const drift = ceilingDrift({ range: ">=4.60.0", latest: "4.59.0" });
    expect(drift.majorsBehind).toBeUndefined();
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

describe("peerInstallSpecs — what check D may ask the registry for alongside the tarball", () => {
  // The half of the substitution that was missing, and the shape of the release it blocked.
  //
  // Measured on usetheokit/theokit#604, cutting `@theokit/http@2.0.0` and `theokit@0.64.0`
  // together. `@theokit/tauri` declares one sibling peer, `theokit: ">=0.36.1"`, so check D ran:
  //
  //   npm install <tauri.tgz> <@theokit/http-2.0.0.tgz> <theokit-0.64.0.tgz> theokit@latest
  //
  // `theokit@latest` is the registry's 0.63.1 — the version that pull request exists to replace —
  // and it depends on `@theokit/http@^1.2.0`. npm honoured the last spec for `theokit`, so the
  // packed 0.64.0 lost to it and the tree carried BOTH `@theokit/http@2.0.0` (packed, at the root)
  // and `@theokit/http@1.2.0` (via the registry's theokit). Check D reported the duplicate, and it
  // was right about the tree it was handed and wrong about the artefact.
  //
  // The duplicate cannot outlive the publish that resolves it: once `theokit@0.64.0` is on the
  // registry, `theokit@latest` requires `@theokit/http@^2.0.0` and there is one copy. So the check
  // was unsatisfiable BEFORE publishing, for every release that bumps a package and a sibling that
  // depends on it — the exact case `unpublishedSiblings` was written for, escaping through the one
  // path it did not cover.
  const localSiblings = [{ name: "theokit", version: "0.64.0", dir: "/w/packages/theo" }];

  it("test_asks_for_latest_when_the_registry_can_answer", () => {
    const refs = [{ dep: "@theokit/sdk", field: "peerDependencies", range: ">=4.0.0" }];
    expect(peerInstallSpecs({ references: refs, localSiblings: [] })).toEqual(["@theokit/sdk@latest"]);
  });

  it("test_does_not_ask_for_a_sibling_the_packed_tarball_already_supplies", () => {
    // The regression. Without this, the substitution is added and then immediately overridden.
    const refs = [{ dep: "theokit", field: "peerDependencies", range: ">=0.36.1" }];
    expect(peerInstallSpecs({ references: refs, localSiblings })).toEqual([]);
  });

  it("asks for the version a prerelease peer range names, not `latest`", () => {
    // After `changeset version` in pre mode every internal peer range points at the prerelease
    // being cut. `latest` is still the previous stable, so asking for it makes npm answer ERESOLVE
    // and the gate reports a package nobody can install — when the package is installable and was
    // simply paired with the wrong sibling. Measured on usetheokit/theokit-sdk#510.
    const refs = [{ field: "peerDependencies", dep: "@theokit/sdk", range: ">=4.63.4-next.0" }];
    const latest = new Map([["@theokit/sdk", "4.63.3"]]);
    expect(peerInstallSpecs({ references: refs, localSiblings: [], latest })).toEqual([
      "@theokit/sdk@4.63.4-next.0",
    ]);
  });

  it("keeps `latest` for a stable range, which is the question that line asks", () => {
    const refs = [{ field: "peerDependencies", dep: "theokit", range: "^0.64.0" }];
    expect(peerInstallSpecs({ references: refs, localSiblings: [] })).toEqual(["theokit@latest"]);
  });

  it("falls back to `latest` rather than throwing on an unparseable range", () => {
    const refs = [{ field: "peerDependencies", dep: "x", range: "nonsense" }];
    expect(peerInstallSpecs({ references: refs, localSiblings: [] })).toEqual(["x@latest"]);
  });

  it("keeps `latest` when the floor is a SENTINEL the registry never published", () => {
    // `>=0.1.0-alpha.0` is the idiom for "0.1.0 or above, prereleases included". The suffix is a
    // sentinel, not a release — asking for it installs `undefined`, which is what broke
    // usetheokit/theokit#626. Latest satisfies the range, so latest is the right ask, and a rule
    // keyed on "the floor looks like a prerelease" gets this backwards.
    const refs = [{ field: "peerDependencies", dep: "@theokit/http", range: ">=0.1.0-alpha.0" }];
    const latest = new Map([["@theokit/http", "2.0.0"]]);
    expect(peerInstallSpecs({ references: refs, localSiblings: [], latest })).toEqual([
      "@theokit/http@latest",
    ]);
  });

  it("keeps `latest` when the registry answer is unknown, rather than inventing one", () => {
    const refs = [{ field: "peerDependencies", dep: "y", range: ">=9.9.9-next.0" }];
    expect(peerInstallSpecs({ references: refs, localSiblings: [] })).toEqual(["y@latest"]);
  });

  it("test_keeps_the_siblings_the_substitution_does_not_cover", () => {
    // Narrow, not blanket: one peer is being published by this cut and one is not, and only the
    // first is dropped. Dropping both would stop exercising a peer the registry can serve.
    const refs = [
      { dep: "theokit", field: "peerDependencies", range: ">=0.36.1" },
      { dep: "@theokit/sdk", field: "peerDependencies", range: ">=4.0.0" },
    ];
    expect(peerInstallSpecs({ references: refs, localSiblings })).toEqual(["@theokit/sdk@latest"]);
  });

  it("test_ignores_anything_that_is_not_a_peer_dependency", () => {
    // Unchanged behaviour, pinned so the filter cannot widen unnoticed: an ordinary dependency
    // travels inside the tarball and must not be installed a second time from the registry.
    const refs = [
      { dep: "@theokit/sdk", field: "dependencies", range: "^4.0.0" },
      { dep: "@theokit/ui", field: "devDependencies", range: "^1.0.0" },
    ];
    expect(peerInstallSpecs({ references: refs, localSiblings: [] })).toEqual([]);
  });

  it("test_ignores_a_local_protocol_range", () => {
    // `workspace:` / `link:` / `file:` / `portal:` never reach a registry, so asking for
    // `@latest` on their behalf would test a package the consumer does not get.
    for (const range of ["workspace:*", "link:../x", "file:../x", "portal:../x"]) {
      const refs = [{ dep: "@theokit/sdk", field: "peerDependencies", range }];
      expect(peerInstallSpecs({ references: refs, localSiblings: [] })).toEqual([]);
    }
  });

  it("test_asks_once_when_a_peer_is_declared_twice", () => {
    // A duplicate spec is how the defect above expressed itself in the first place; the output
    // is a command line, and repeating a name on it invites npm to pick between two answers.
    const refs = [
      { dep: "@theokit/sdk", field: "peerDependencies", range: ">=4.0.0" },
      { dep: "@theokit/sdk", field: "peerDependencies", range: ">=4.1.0" },
    ];
    expect(peerInstallSpecs({ references: refs, localSiblings: [] })).toEqual(["@theokit/sdk@latest"]);
  });
});
