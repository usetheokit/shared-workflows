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
  return { range, latest, majorsBehind: majorsBetween(range, latest) };
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
