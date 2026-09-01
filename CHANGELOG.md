# Changelog

Changes to the reusable workflows, composite actions and the `@theokit/dep-check`
package this repository publishes.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **`@theokit/dep-check` check D no longer contradicts itself on a release that bumps a package and
  one of its dependents together.** The check installs a package's sibling peers from the registry
  at `@latest` alongside the packed tarball, and it built that list independently of
  `unpublishedSiblings` — so when a peer was one this cut was about to publish, `<peer>@latest` and
  the packed tarball landed on the same `npm install` command line. npm honours the last spec for a
  name, the registry copy won, and the substitution written to make such a release pass was defeated
  by the argument next to it.

  Measured on `usetheokit/theokit#604`, cutting `@theokit/http@2.0.0` and `theokit@0.64.0` together:
  `theokit@latest` was still 0.63.1, which depends on `@theokit/http@^1.2.0`, so the tree carried
  `@theokit/http` twice and the gate reported a duplicate that could not outlive the publish
  resolving it. The check was unsatisfiable BEFORE publishing, for exactly the release shape
  `unpublishedSiblings` exists to support.

  `peerInstallSpecs` now computes that list FROM the substitution, dropping only the peers the
  packed tarballs already supply. A peer the registry can serve keeps its `@latest`, because the
  point of the leg is to install what a consumer would actually get.

### Added

- A reusable SonarQube Cloud analysis workflow (`.github/workflows/sonar.yml`). Callers get a scan
  that imports coverage, which Automatic Analysis cannot do — its documentation states that "code
  coverage information is not supported". It requires `sonar-project.properties` at the repository
  root and fails loudly without it, because a scanner with no declared scope reads build output and
  reports a source file as a duplicate of its own bundle. A missing `SONAR_TOKEN` warns and skips
  rather than failing, so adopting the workflow does not turn a repository red before the secret
  exists.

  It exists as one workflow rather than eight copied steps for a measured reason: the only inline
  version in the ecosystem, in `theokit-tui`, carried `if: matrix.node-version == '22.x'` against a
  matrix of `['22.12', '22']`. The condition was never true, the step reported `skipped` on every
  run for two months, and a skipped step is indistinguishable from a passing one in the checks list.

- `sonar.yml` inputs `build-command` and `coverage-artifact`, both for the same defect: a scan that
  passes while measuring nothing. `theokit-sdk`'s first run reported `No coverage information will
  be saved because all LCOV files cannot be found` — its packages import each other through their
  published entry points, so nine suites failed to load before `pnpm build` had run.
  `build-command` runs first; `coverage-artifact` downloads coverage an earlier job already
  uploaded, for callers whose suite needs an environment (a sibling repository built from source,
  native bindings, bubblewrap) that reproducing here would only duplicate. The two coverage inputs
  are mutually exclusive and the workflow refuses a caller that sets both.


### Added

- **`@theokit/release-channel` + `actions/release-channel`** — a guard that refuses a release whose
  declared channel and actual changesets prerelease state disagree. `changeset pre exit`, a bad
  merge, or a conflict resolved the wrong way removes `.changeset/pre.json`; nothing errors; the
  next release publishes a stable version, moves the `latest` dist-tag for every consumer, and
  reports success. The guard requires two facts to agree — `"releaseChannel"` in the root manifest
  and `pre.json` — so cutting a stable release stays possible and becomes deliberate: it takes an
  edit a reviewer sees in the diff. 23 tests, including that a corrupt `pre.json` is never read as
  "we are on latest", which is the direction that publishes.

- **`actions/snapshot`** — publishes the current tree under a dist-tag that is never `latest`, so a
  change is installable from the registry before it is merged, including from another repository.
  A monorepo snapshots so a reviewer can install a pull request; an ecosystem of separate
  repositories needs it for the sharper case — `@theokit/http` reaching 2.0.0 in one repository
  while another declares a range that excludes it, which on 2026-08-31 left three published
  packages uninstallable by any npm user until a release gate found it.

  A composite action rather than a reusable workflow, deliberately: the steps run inside the
  caller's job, so the OIDC token is still minted by `release.yml` and every npm trusted-publisher
  connection — which matches per package, per repository and per workflow file — keeps matching.

  It exits prerelease mode **in the runner's copy only**, because `changeset version --snapshot`
  refuses outright while pre mode is on (`Snapshot release is not allowed in pre mode`). The last
  step asserts `HEAD` never moved, so a future edit cannot turn that ephemeral exit into a real one.

## [dep-check 0.9.1] - 2026-08-27

### Fixed

- The organisation-wide audit labels an `ahead` range the same way check C does. `0.9.0` gave
  `ceilingDrift` a direction and taught check C to use it, and left the audit reading the old
  shape — so a published package whose floor sits above `latest` would have printed
  `(undefined behind)` and been filed under `contract`. Introduced by `0.9.0` and caught before
  it ran anywhere (#24)


## [dep-check 0.9.0] - 2026-08-27

### Fixed

- Check C distinguishes a range that is **ahead** of the registry from one that is behind it. Both
  miss `latest`, and they are opposite problems: behind means the range stopped at an older major,
  ahead means its floor is above everything published, so the package installs nowhere. The second
  was reported as `0 majors behind` — a reader scanning the column saw a number that reads as
  "roughly up to date" for a package no consumer can install (#24)

  It has a name of its own now, `unpublished`, and sorts above `contract`: a range the registry
  cannot satisfy at all is worse than a stale one. It is the expected state mid-way through a
  two-release change — a satellite declaring the floor it will need before the sibling publishes —
  and a defect if it outlives one, which is exactly the distinction the label has to carry.


## [dep-check 0.8.0] - 2026-08-27

### Fixed

- A sibling that lives in the workspace under test is no longer written into the **global** floor
  override. The override is one value for the whole tree, so forcing a published version over a
  workspace link failed the packages that consume it through `workspace:` and never see an old one.
  Measured on `usetheokit/theokit`: `@theokit/http` was pinned at `0.4.0` — the floor of the
  `>=0.1.0-alpha.0` that `@theokit/agents` declares — and `packages/theo`, which declares
  `workspace:^` and claims nothing about `0.4.0`, failed to build against a version it has never
  been paired with. That is the defect #4 was, in a new place (#22)

### Changed

- Those floors are not dropped, they move to the per-package runs, where the floor is installed and
  only the packages that actually declare it are built. Dropping them would have cost a real
  finding: theokit-di#44 was found exactly this way. Coverage is strictly larger than before —
  `theokit-di` now exercises `@theokit/di@0.1.1` for `di-agent` and `@theokit/di@0.2.0` for `orm`
  as separate claims, where the global override could only ever test one of them (#22)


### Fixed

- `v1` follows `main`, not only releases. The release moves it after a publish, which covers a
  change that bumps the package — and not a change to the workflows themselves. The full-depth
  checkout, the build step, the per-package floor runs and the stable result check all landed on
  `main` with no version bump, and every one had to be pushed to `v1` by hand or it reached no
  consumer. Same class as #13: shipped, green, not delivered.

  It holds when the pinned `dep-check-version` is not on the registry yet, which is the state a
  version bump lands in before its tag: moving there would send consumers to
  `npx @theokit/dep-check@<unpublished>`, a failure at the point of use rather than a stale one
  (#15)


### Added

- `floors the shared pin cannot reach — result`, a check with a stable name that reports whether
  the per-package floor runs passed. The runs themselves are named after their matrix entry, which
  is what makes a failure legible without opening anything — and means the name changes with the
  repository's declared ranges, so it can never be a required check, and renders uninterpolated
  when the matrix is empty. This one always reports, fails if any entry failed, and treats a
  skipped matrix with a non-zero count as a gap rather than a pass. It is the one to mark required
  (#16)


## [dep-check 0.7.0] - 2026-08-27

### Added

- The floor leg exercises the floors a single global override cannot reach. It writes one override
  per sibling, so it can only pin a version every declared range admits — the bottom of the
  intersection — and where ranges diverge the lower floors were never installed. `0.5.0` started
  naming them; this runs them. One extra job per (sibling, unexercised floor), installing that
  floor and running only the packages that declare it (#16)

  The gap was not hypothetical: four packages in `theokit-sdk` declared `>=4.0.0` and none compiled
  against `4.0.1` (theokit-sdk#423) — live on the registry across ~54 releases of claimed interval,
  invisible to the shared pin, and found only by installing per package.

- `dep-check floor-matrix`, which prints those runs as JSON for a workflow matrix, and `pin-one`,
  which pins a single sibling. `run-command` and `build-command` take `--package` (#16)

### Fixed

- `build-command --package` builds the named package **and its workspace dependencies**, not the
  whole workspace. Building everything at a floor only some packages claim fails the ones whose own
  ranges exclude it — measured on `theokit-sdk`, where building at `@theokit/sdk@4.4.1` failed on
  `sdk-cache`, which declares `>=4.54.0`. That is the defect #4 was, one level down (#16)

- Diagnostics from the floor commands go to stderr rather than stdout, so `floor-matrix` output
  parses as JSON (#16)


### Added

- The release advances `v1` itself, after verifying the registry actually serves the version and
  then reading the ref back to confirm it moved. It was the last manual step in a release and had
  been missed on two of six — `0.2.0` left the tag serving `0.1.0` and blocked the gate on
  `theokit#521`; `0.5.0` left it serving `0.4.0`, so no consumer received that release. It runs as
  a separate job holding `contents: write` and no OIDC, so the job that mints the npm credential
  gains no repository write (#15)


## [dep-check 0.6.0] - 2026-08-27

### Fixed

- Check D can pass on a version pull request that bumps a package and a sibling it depends on in
  the same cut. It could not before, and no manifest change could make it: `pnpm pack` rewrites
  `workspace:^` to the new local version — correctly — and the install then asked npm for the
  version that pull request exists to publish, answering `ETARGET`. Measured on
  `usetheokit/theokit#524`, where `theokit@0.57.0` asked for `@theokit/agents@^12.1.0` while the
  registry had `12.0.0`. Every monorepo publishing two interdependent packages together meets this
  on its first version pull request (#17)

  Siblings the registry does not have yet are now packed from the workspace and installed from
  those tarballs, transitively — a substituted tarball brings its own unpublished asks with it, and
  filling only the direct reference moved the `ETARGET` one level down. The substitution is
  deliberately narrow: a sibling the registry already serves is still installed from the registry,
  and a dependency that is not a workspace package at all still fails the install, which is the
  case this check exists to catch.

  Every substitution is printed. A tarball taken from the workspace is a weaker check than one
  resolved from the registry, and a reader deciding what a green D means has to know which one they
  got (#6, #17)


### Fixed

- The gate runs the `@theokit/dep-check` version that was just released. `0.5.0` published to npm
  while the workflow's `dep-check-version` default stayed at `0.4.0` and the `v1` tag stayed on the
  commit before it, so no consumer received the release — the floor leg went on not naming its
  untested floors. Second time the moving ref has been left behind after a publish; the first was
  `0.2.0` (#13)

### Added

- The release refuses to publish a version the gate does not run. `release.yml` now compares the
  manifest version against the `dep-check-version` default in `dep-check.yml` and fails when they
  disagree, which is the state `0.5.0` published in. It guards the pin; moving `v1` is a separate
  step and a separate failure (#13)


## [dep-check 0.5.0] - 2026-08-27

### Added

- The range-floor leg names the declared floors it does NOT exercise. It pins the bottom of the
  intersection of every declared range, which is the only version a single global override can
  honestly take — and the consequence is that when two packages declare different ranges for the
  same sibling, only the higher floor is ever installed. `@theokit/di-agent` promises
  `@theokit/di >=0.1.1` and nothing verified 0.1.1; four packages in `theokit-sdk` promise
  `>=4.0.0` and only 4.19.3 ran. The gap is not closed — closing it means installing each package
  against its own floor, N installs and a different job shape — but it is no longer invisible, so
  a green leg is not read as coverage it does not have (#6)

### Fixed

- The range-floor job checks out at full depth. It used the default depth of 1, so a suite that
  consults git history failed on the clone rather than on a range — `theokit-tui`'s never-weaken
  guard diffs against a base SHA that a shallow clone does not contain. Its own CI checks out at
  depth 0 for exactly this reason. Workflow-only — it needed no release of its own, and ships
  here because this one carries it (#9)

## [dep-check 0.4.0] - 2026-08-27

### Fixed

- The range-floor leg builds the repository before running its suite. It reinstalled at the
  floor and went straight to the tests, so the suite ran against a tree with no `dist/` —
  an arrangement no CI in this ecosystem produces. `theokit-tui` failed its publish-contract
  test on `publint --strict`, and `theokit` reported `SKIP: dist/index.js not found (run
  pnpm build first)` alongside TS2307s for subpaths that exist only once built. Neither
  failure was about a declared range, and both read as one (#7)

### Added

- `dep-check build-command`, which prints the repository's build command — `build` when it
  exists, `build:packages` otherwise, and nothing at all for a repository that does not
  build, so the step is skipped rather than failed (#7)

## [dep-check 0.3.0] - 2026-08-27

### Fixed

- The range-floor leg no longer pins a sibling to a version some consumer's own range
  excludes. When several packages in one workspace declared different ranges for the same
  sibling, it took the lowest individual floor and wrote it as a single global override —
  so a package declaring `^0.2.0` had its suite run against `0.1.1` and was reported as
  broken for a combination no installer would resolve. The floor is now the bottom of the
  intersection: the lowest published version every declared range admits. Measured on
  `usetheokit/theokit-di`, where `@theokit/di-agent` declares `>=0.1.1 <0.3` and
  `@theokit/orm` declares `^0.2.0` — the leg now pins `0.2.0` rather than `0.1.1` (#4)
- A sibling whose declared ranges share no published version is reported and left unpinned
  instead of silently resolved in favour of one of them. A workspace that cannot be
  installed as declared is a finding, not something for the floor leg to arbitrate (#4)

## [dep-check 0.2.0] - 2026-08-27

### Fixed

- The tarball the install leg tests is packed with the workspace's own package manager,
  detected from the repository root rather than from the package directory. In a workspace
  the lockfile sits at the root, so detecting from the package fell back to npm — which
  copies `workspace:` ranges verbatim and produces a tarball that installs nowhere. Every
  `workspace:`-depending package was reported as an install failure (#1)
- A run whose install leg was skipped no longer reads as one where it passed. The job
  writes what it actually checked to the step summary and emits a notice when a leg did
  not run (#1)

## [dep-check 0.1.0] - 2026-08-26

### Added

- First release. Checks declared sibling ranges against what is installed, against the
  registry, against the bottom of each declared range, and against a tarball installed the
  way a consumer would install it.
