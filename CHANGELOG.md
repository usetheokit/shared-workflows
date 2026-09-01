# Changelog

Changes to the reusable workflows, composite actions and the `@theokit/dep-check`
package this repository publishes.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- **New `actions/manifest-check`:** the published-manifest contract, checked instead of remembered.
  Audited across 50 publishable packages on 2026-09-01, and every rule is a defect that was found
  rather than a style someone preferred: 38 did not export `./package.json`, 30 had no `keywords`,
  18 declared no `sideEffects` at all, 12 had no `bugs` and 12 no `homepage`.

  The first was reproduced, not argued — `require('@theokit/di/package.json')` threw
  `ERR_PACKAGE_PATH_NOT_EXPORTED` while `@mastra/core` resolved. Bundlers, test-runner resolvers and
  version telemetry read that subpath.

  `sideEffects` must be DECLARED and may be any value: the check refuses silence, not a particular
  answer, because the right answer is not always `false`. `@theokit/di-agent` carries a module-scope
  `import "reflect-metadata"` in sixteen files, so `false` there would authorise a bundler to delete
  the polyfill and leave decorators without metadata in a consumer's production build.

  Two things this locks in that were already right: `types` is the first condition in all 50 exports
  maps — Node resolves conditions in declaration order, so a `types` after `import` is never reached
  — and every package publishes with `provenance: true`, which neither `next` nor `@mastra/core`
  does.

- **New `actions/checks-pass`:** a fan-in so ONE required status check can stand for every job in a
  workflow. Branch protection requires checks BY NAME, so every job added afterwards is advisory
  until somebody edits the list in every repository by hand. Measured across the ecosystem on
  2026-09-01: `theokit` required 14 of the 52 checks that ran, `theokit-ui` 5 of 30, `theokit-sdk` 5
  of 20 — and `release channel`, the gate that stops a stable publish moving the `latest` dist-tag
  for every consumer, was required in ZERO repositories the week it was written. The fan-in makes
  the required name a property of the workflow instead of a list somebody maintains.

  A skipped dependency FAILS unless the caller names it in `allowed-skips`: a job that did not run
  reads exactly like a job that passed, which is the failure being closed, so it is not waived by
  default. The logic lives in `check.sh` rather than inline in `action.yml`, so the CI job that
  exercises its ten refusals runs the same bytes the action does instead of a copy that can rot
  apart from it.

  One constraint found by CI rather than by reading: the runner evaluates expressions inside a
  manifest's `description`, and `needs` is not a named value in an action's context — so spelling the
  usage example out in that field fails the whole action to load. The example lives in a comment.

- **`dep-check` 0.9.4:** check D now decides by SATISFACTION rather than by appearance. It asks for
  `@latest` when the served version satisfies the declared range, and for the range's floor only
  when it does not. 0.9.3 keyed on "the floor looks like a prerelease" and got the second shape
  backwards: `>=0.1.0-alpha.0` is the idiom for "0.1.0 or above, prereleases included", the suffix
  is a **sentinel** that was never published, and asking for it installed `undefined`
  (usetheokit/theokit#626). The first shape stays fixed: `>=4.63.4-next.0` against a `latest` of
  4.63.3 still pairs with the floor (usetheokit/theokit-sdk#510). One rule now covers both, and it
  is the question the check actually asks.

- **`preview.yml`:** no preview on a back-merge. A `main → workspace` pull request carries content
  that is already published, so there is nothing to preview — and those pull requests are opened by
  `github-actions[bot]`, whose runs GitHub holds for manual approval. Nobody approves them, so each
  expired and landed in the checks list as a failure: a red mark meaning "a preview nobody needed
  was not produced". A check that is red on every back-merge is a check people stop reading, and
  being read is the entire value of this one.

  `develop` is deliberately not excluded: a `develop -> main` pull request is the RELEASE, and its
  content is about to be published rather than already published — the one moment a preview answers
  something. Dependabot's pull requests are unaffected; measured, they run and pass.

### Fixed

- **`dep-check`:** check D asks for the version a prerelease peer range NAMES, instead of `@latest`.
  After `changeset version` in prerelease mode every internal peer range points at the prerelease
  being cut — `@theokit/sdk-tools@0.27.4-next.0` asks for `@theokit/sdk@">=4.63.4-next.0"` — while
  `latest` is still the previous stable. npm then answers ERESOLVE and the gate reported a package
  nobody can install, when the package was installable and had been paired with the wrong sibling.
  No range string can admit future prereleases (semver by design), so the rewrite is not avoidable
  and this is where it has to be understood. `@latest` stays the ask on a stable line, which is the
  question that line asks. Measured on usetheokit/theokit-sdk#510.

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

- **`.github/workflows/preview.yml`** — per-commit package previews via pkg.pr.new, reusable by
  every repository instead of living in one. A fix here is unverifiable from a sibling repository
  until it is on a registry; nine publishable repositories depend on each other, so that gap is
  where this ecosystem's expensive defects live. Previews cost nothing and burn no npm version,
  which is why they are the first thing to reach for — `actions/snapshot` is for when the answer
  has to come from registry.npmjs.org specifically.

  A reusable workflow rather than a composite action, and the difference from `actions/snapshot`
  is not stylistic: nothing here talks to npm, so there is no trusted-publisher constraint forcing
  the steps into the caller's job.

  The publishable-package list is derived from the `private` flag across `packages/*` and `apps/*`
  — handing pkg-pr-new a private package is undocumented behaviour. Verified identical to
  `theokit-sdk`'s own `list-publishable-packages.mjs` across all seven changesets repositories.

  The package manager is detected from the lockfile rather than assumed — the shape `sonar.yml`
  already sets, with an `install-command` override. Nine repositories here use pnpm and one uses
  npm, and a workflow that assumed pnpm simply left that one without previews, which is how a
  shared mechanism quietly becomes an eight-of-nine mechanism. `build-command` accepts an empty
  string for a package that publishes its sources, so "no build" is stated rather than worked
  around.

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
