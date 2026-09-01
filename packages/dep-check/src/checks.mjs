/**
 * The decision layer of the ecosystem dependency gate.
 *
 * Every function here is pure: manifests and registry answers go in, findings come
 * out. The I/O lives in `registry.mjs` and `ecosystem.mjs` so that the part which
 * has to be RIGHT can be tested against the historical defects it exists to catch —
 * see `test/checks.test.mjs`, which pins the three ranges that actually shipped.
 *
 * A note on why there are four checks and not one. They differ in what they need to
 * answer (a lockfile, or the network), and therefore in whether they may block a
 * build. Collapsing them would mean either blocking on a third party's release
 * schedule, or not blocking at all.
 */
import semver from "semver";

/** Ranges no registry can resolve. `workspace:` is pnpm's, resolved at pack time. */
const LOCAL_PROTOCOL = /^(workspace|link|file|portal):/;

/**
 * Is this an ecosystem sibling — a package this organisation publishes and whose
 * versions it controls?
 *
 * Matched on the exact scope rather than a prefix: `theokit-studio` is a repository
 * name and `@theocode/*` is a different product, and neither belongs here.
 */
export function isSibling(name) {
  return name === "theokit" || name.startsWith("@theokit/");
}

/** How many majors separate a version from a range's upper bound. 0.x minors count. */
function majorsBetween(range, version) {
  const target = semver.parse(version);
  if (!target) return 0;
  // In 0.x, semver treats a minor as a breaking boundary, and so does the caret.
  // Reporting `^0.26.1` vs `0.27.1` as "0 majors behind" would read as harmless
  // when it is a hard exclusion.
  const unit = target.major === 0 ? "minor" : "major";
  const bound = semver.minVersion(range);
  if (!bound) return 0;
  return Math.max(0, target[unit] - bound[unit]);
}

/**
 * Check C — the declared range against the sibling's published `latest`.
 *
 * This is the only check that catches a range going stale, and the only one that
 * needs the network. It is therefore the only one that must NOT fail a build: on
 * the day a sibling publishes a major, every repository in the organisation would
 * go red without anyone having touched anything, and a build that breaks on someone
 * else's release schedule teaches the team to ignore red.
 */
export function ceilingDrift({ range, latest }) {
  if (!range || !latest || LOCAL_PROTOCOL.test(range)) return null;
  // A `next` release briefly holding the `latest` tag is not a reason to open a
  // pull request against every consumer.
  if (semver.prerelease(latest)) return null;
  if (semver.satisfies(latest, range)) return null;
  // A range can miss `latest` from either side, and the two are opposite problems.
  //
  // BEHIND is the ordinary one: the range stopped at an older major and the world moved on.
  // AHEAD happens during a two-release change — a satellite declares the floor it will need
  // before the version exists, so nobody can install it until the other package publishes.
  // Reporting that as `0 majors behind` describes its mirror image: a reader scanning the
  // column sees a number that reads as "roughly up to date" for a package that installs nowhere.
  const floor = semver.minVersion(range);
  if (floor && semver.gt(floor, latest)) {
    return { range, latest, direction: "ahead" };
  }
  return { range, latest, direction: "behind", majorsBehind: majorsBetween(range, latest) };
}

/**
 * Check A — the declared range against the version the lockfile actually installs.
 *
 * Offline, deterministic, and safe to block on. It is deliberately NOT the check
 * that would have caught the two defects this gate was built for: both declared a
 * peer and a devDependency that agreed with each other perfectly, three and four
 * majors behind the world. A repository closed over itself cannot see that.
 *
 * What it does catch is the inverse — a range tightened while the lockfile still
 * resolves something outside it, which is how a "fix" ships untested.
 */
export function installedDrift({ range, installed }) {
  if (!range || LOCAL_PROTOCOL.test(range)) return null;
  // An optional peer the repository does not install is not a defect.
  if (!installed) return null;
  if (semver.satisfies(installed, range)) return null;
  return { range, installed };
}

/**
 * Check B — the lowest PUBLISHED version a range admits, so the suite can be run
 * against the bottom of its own claim rather than only the top.
 *
 * Published, not theoretical: `>=4.0.0` admits 4.0.0, which `@theokit/sdk` never
 * released. Installing a version that does not exist fails on resolution while
 * looking like it failed on the version — the exact confusion `version-floor.test.ts`
 * documents having walked into four times.
 */
export function rangeFloor(range, publishedVersions) {
  if (!range || LOCAL_PROTOCOL.test(range)) return null;
  const stable = publishedVersions.filter((v) => !semver.prerelease(v));
  const admitted = stable.filter((v) => semver.satisfies(v, range));
  return admitted.length ? semver.sort(admitted)[0] : null;
}

/**
 * The sibling references a floor override may legitimately pin.
 *
 * A sibling that lives in THIS workspace is not one of them. Pinning it replaces the workspace
 * link with a published version, and that combination exists nowhere: in development the link is
 * used, and once published `workspace:^` is rewritten to the CURRENT local version, never an old
 * one. Measured on usetheokit/theokit#526 — `@theokit/http` lives at `packages/http` there, the
 * override installed `0.4.0` over it, and `packages/theo` failed to build against a version it
 * has never been paired with:
 *
 *     error TS2724: '"@theokit/http"' has no exported member named 'createDecoratorHandler'
 *
 * The declared range is still a claim worth checking — it is a promise to consumers outside this
 * repository. The check that tests it is D, which installs the packed tarball the way a consumer
 * would, against what the registry actually serves. Not an override that overwrites a sibling
 * with its own past.
 *
 * An empty member list pins everything: failing open here would make the leg a silent no-op.
 */
export function pinnableSiblings(references, workspaceMembers) {
  const members = new Set(workspaceMembers ?? []);
  return references.filter((r) => !members.has(r.dep));
}

/**
 * The extra runs needed to exercise the floors the intersection cannot reach.
 *
 * `untestedFloors` names them; this turns that list into work. One entry per distinct
 * (sibling, floor) pair, carrying every package that declares it — `theokit-plugins` has fourteen
 * packages on `theokit >=0.50.1`, and fourteen installs of the same version would cost fourteen
 * times as much to prove one thing.
 *
 * Sorted, because an unstable matrix makes one failing job impossible to compare against the same
 * job yesterday.
 */
export function groupUntestedFloors(untested) {
  const byFloor = new Map();
  for (const gap of untested) {
    const key = `${gap.dep}\u0000${gap.claims}`;
    if (!byFloor.has(key)) byFloor.set(key, { dep: gap.dep, version: gap.claims, range: gap.range, tested: gap.tested, packages: [] });
    byFloor.get(key).packages.push(gap.pkg);
  }
  for (const g of byFloor.values()) g.packages.sort();
  return [...byFloor.values()].sort((a, b) => a.dep.localeCompare(b.dep) || semver.compare(a.version, b.version));
}

/**
 * The siblings check D must take from the workspace, because the registry does not have them yet.
 *
 * A version pull request bumps a package and a sibling it depends on in the same cut. `pnpm pack`
 * rewrites `workspace:^` to the NEW local version — correctly — and then the install asks npm for
 * a version whose whole purpose is to be published by that same pull request. `ETARGET`.
 *
 * Measured on usetheokit/theokit#524: `theokit@0.57.0` asking for `@theokit/agents@^12.1.0` while
 * the registry had `12.0.0`. Nothing about a manifest fixes it, and every monorepo that publishes
 * two interdependent packages together meets it on its first version pull request. The earlier one
 * there predates this gate, which is why nobody had met it before.
 *
 * Deliberately narrow. A sibling the registry already has is NOT substituted: installing a local
 * tarball for a published version would quietly stop testing what a consumer actually resolves.
 * A dependency that is not a workspace package at all is not substituted either — a genuinely
 * missing dependency is the case this check exists to catch, and it is indistinguishable from the
 * outside if this swallows it. Only the gap is filled, and the caller reports what it filled.
 */
/**
 * The peers check D installs from the registry alongside the packed tarball.
 *
 * A peer is not inside the tarball — the consumer supplies it — so the check has to supply one too,
 * or it exercises a tree no consumer will ever have. `@latest` is the right ask for a peer the
 * registry can answer.
 *
 * It is the wrong ask for a peer THIS CUT IS ABOUT TO PUBLISH, and that is what this function
 * exists to remove. `unpublishedSiblings` already packs such a sibling and hands it over as a file,
 * but the `@latest` spec was built independently and landed on the same command line. npm honours
 * the last spec for a name, so the packed tarball lost to the registry copy and the substitution
 * was defeated by the argument next to it.
 *
 * Measured on usetheokit/theokit#604, cutting `@theokit/http@2.0.0` and `theokit@0.64.0` together:
 *
 *   npm install <tauri.tgz> <@theokit/http-2.0.0.tgz> <theokit-0.64.0.tgz> theokit@latest
 *
 * `theokit@latest` was 0.63.1 — the version that pull request existed to replace — which depends on
 * `@theokit/http@^1.2.0`. The tree then held `@theokit/http` twice, 2.0.0 packed at the root and
 * 1.2.0 under the registry's theokit, and check D reported a duplicate. It was right about the tree
 * it was handed and wrong about the artefact: once `theokit@0.64.0` is published, `theokit@latest`
 * requires `^2.0.0` and there is one copy. The finding could not outlive the publish that resolved
 * it, so the check was unsatisfiable BEFORE publishing — for every release that bumps a package and
 * a sibling depending on it, which is the case `unpublishedSiblings` was written for.
 *
 * Narrow on purpose: only a sibling the substitution actually covers is dropped. A peer the
 * registry can serve keeps its `@latest`, because the point of the leg is to install what a
 * consumer would get.
 */
export function peerInstallSpecs({ references, localSiblings = [], latest = new Map() }) {
  const packed = new Set(localSiblings.map((s) => s.name));
  const specs = new Set();
  for (const r of references) {
    if (r.field !== "peerDependencies") continue;
    if (LOCAL_PROTOCOL.test(r.range ?? "")) continue;
    if (packed.has(r.dep)) continue;

    // Ask for `@latest` when `latest` SATISFIES the declared range, and for the range's floor only
    // when it does not. That is the question this check asks — can a consumer install this package
    // beside the sibling the registry serves — so it is the one worth answering directly.
    //
    // Two shapes make the naive answers wrong, and each broke a release here:
    //
    //   `>=4.63.4-next.0` with latest 4.63.3   — after `changeset version` in prerelease mode a
    //     package declares the peer it was built against, and `latest` does not satisfy it. Asking
    //     for `@latest` makes npm answer ERESOLVE and the gate report a package nobody can install,
    //     when it is installable and was paired with the wrong sibling. (theokit-sdk#510)
    //
    //   `>=0.1.0-alpha.0` with latest 2.0.0    — the `-alpha.0` is the idiom for "any version at or
    //     above 0.1.0, prereleases included". It is a SENTINEL, not a release: 0.1.0-alpha.0 was
    //     never published. Asking for it installs `undefined`. Latest satisfies this range, so
    //     `@latest` is right — and a rule keyed on "the floor looks like a prerelease" gets it
    //     backwards. (theokit#626)
    //
    // Satisfaction distinguishes them without needing to know which shape it is looking at.
    const known = latest.get(r.dep);
    let spec = `${r.dep}@latest`;
    if (r.range && known && !semver.satisfies(known, r.range)) {
      try {
        const floor = semver.minVersion(r.range);
        if (floor) spec = `${r.dep}@${floor.version}`;
      } catch {
        // An unparseable range is not a reason to invent a version. `@latest` at least exists.
      }
    }
    specs.add(spec);
  }
  return [...specs];
}

export function unpublishedSiblings({ references, workspace, published }) {
  const byName = new Map(workspace.map((p) => [p.name, p]));
  const out = [];
  const seen = new Set();
  // Transitively, because a substituted tarball brings its own unpublished asks with it.
  // `@theokit/tauri` depends on `theokit@0.57.0`, which is substituted — and that tarball then
  // requests `@theokit/agents@^12.1.0`, still absent from the registry. Substituting only the
  // direct reference moves the ETARGET one level down instead of resolving it.
  const queue = references.map((r) => r.dep);
  while (queue.length) {
    const dep = queue.shift();
    if (seen.has(dep)) continue;
    seen.add(dep);
    const local = byName.get(dep);
    if (!local) continue;
    const versions = published[dep];
    // Missing is not empty: an unreachable registry must not read as "nothing is published",
    // or every sibling gets a local tarball and the check tests nothing real.
    if (!Array.isArray(versions) || !versions.length) continue;
    if (versions.includes(local.version)) continue;
    out.push({ name: dep, version: local.version, dir: local.dir });
    for (const r of local.references ?? []) queue.push(r.dep);
  }
  return out;
}

/**
 * The floor for a sibling that SEVERAL packages in one workspace declare.
 *
 * The override the floor leg writes is a single global value, so it has to be a version
 * every declared range admits — the bottom of their intersection, not the bottom of any
 * one of them. Taking the lowest individual floor pins a version that some consumer's
 * own range excludes, and then runs that consumer's suite there: a combination no
 * installer would ever resolve, failing for a reason the packages are not responsible
 * for. Measured on `usetheokit/theokit-di`, where `@theokit/di-agent` declares
 * `>=0.1.1 <0.3` and `@theokit/orm` declares `^0.2.0` — the lowest-wins rule pinned
 * 0.1.1, outside the ORM's range, and reported the ORM as broken.
 *
 * Returns null when the ranges share no published version. That is a real defect —
 * the workspace cannot be installed as declared — but it belongs to whoever reads the
 * result, not to a rule here that silently picks a side.
 */
export function sharedFloor(ranges, publishedVersions) {
  const declared = ranges.filter((r) => r && !LOCAL_PROTOCOL.test(r));
  if (!declared.length) return null;
  const stable = publishedVersions.filter((v) => !semver.prerelease(v));
  const admitted = stable.filter((v) => declared.every((r) => semver.satisfies(v, r)));
  return admitted.length ? semver.sort(admitted)[0] : null;
}

/**
 * The declared floors the intersection floor does NOT exercise.
 *
 * `sharedFloor` pins one version every range admits, which is the only value a single global
 * override can honestly take. The consequence is that when two packages declare different ranges
 * for the same sibling, only the HIGHER floor is ever installed — the lower one stops being tested
 * while still being promised. On `usetheokit/theokit-di`, `@theokit/di-agent` declares
 * `>=0.1.1 <0.3` and nothing verifies 0.1.1 any more; on `usetheokit/theokit-sdk`, four packages
 * declare `>=4.0.0` and only 4.19.3 runs.
 *
 * This does not close the gap — closing it means installing each package against its own floor,
 * which is N installs and a different job shape. It names the gap, so a green check is not read as
 * coverage it does not have. A gate that quietly tests less than it appears to is the failure mode
 * the floor leg exists to prevent, turned on itself.
 */
export function untestedFloors({ declarations, pinned, publishedVersions }) {
  if (!pinned) return [];
  const untested = [];
  for (const { pkg, range } of declarations) {
    const claims = rangeFloor(range, publishedVersions);
    // `null` is a range admitting nothing published — a finding of its own, reported
    // elsewhere; equal-or-higher means the pinned version IS this package's floor.
    if (claims && semver.lt(claims, pinned)) untested.push({ pkg, range, claims, tested: pinned });
  }
  return untested;
}

/**
 * The reverse check — run by the PUBLISHER before cutting a major.
 *
 * Every other check lives in the consumer, and therefore fires after the fact: the
 * earliest a consumer can learn it was left behind is the moment the sibling has
 * already published. This one moves the warning to the release pull request of the
 * package causing the break, where someone can still decide what to do about it.
 */
export function consumersLeftBehind({ consumers, nextVersion, direction }) {
  const found = [];
  for (const consumer of consumers) {
    const { range } = consumer;
    if (!range || LOCAL_PROTOCOL.test(range)) continue;
    if (semver.satisfies(nextVersion, range)) continue;
    // "Excludes the new version" covers two different situations, and only one of
    // them is the publisher's problem. A consumer whose range sits BELOW the release
    // is stranded by it. A consumer already requiring something ABOVE it is not — the
    // checkout asking the question is simply behind the registry, which is how
    // `theokit@0.56.0` showed up requiring agents ^12.0.0 during a sweep run against a
    // checkout still holding 11.1.0. Reporting both identically puts a finding in a
    // release with nothing the releaser can act on.
    const floor = semver.minVersion(range);
    const consumerDirection = floor && semver.gt(floor, nextVersion) ? "ahead" : "behind";
    if (direction && consumerDirection !== direction) continue;
    found.push({ ...consumer, direction: consumerDirection });
  }
  return found;
}

/**
 * Check D — two copies of one runtime in an installed tree.
 *
 * Asked separately from "did the install fail?" because the studio defect did not
 * fail: npm resolved it happily, installed `@theokit/agents` twice and hoisted the
 * four-majors-old copy to the root, where application code reached it first. A gate
 * that only watches the exit code is green on exactly the worse outcome.
 *
 * Takes the parsed output of `npm ls --all --json`.
 */
export function duplicateSiblingCopies(tree) {
  const seen = new Map();
  const walk = (node) => {
    for (const [name, child] of Object.entries(node?.dependencies ?? {})) {
      if (isSibling(name) && child?.version) {
        if (!seen.has(name)) seen.set(name, new Set());
        seen.get(name).add(child.version);
      }
      walk(child);
    }
  };
  walk(tree);
  return [...seen.entries()]
    .filter(([, versions]) => versions.size > 1)
    .map(([dep, versions]) => ({ dep, versions: semver.sort([...versions]) }));
}
