# Changelog

Changes to the reusable workflows, composite actions and the `@theokit/dep-check`
package this repository publishes.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
