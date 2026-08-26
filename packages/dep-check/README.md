# dep-check

The ecosystem dependency gate. It answers four questions about how a package declares its siblings,
and refuses to answer any of them by guessing.

## Why four commands and not one

They differ in what they need in order to be answered, and therefore in whether they may fail a
build. Collapsing them would mean either blocking on someone else's release schedule, or not
blocking at all.

| Command | Question | Needs the network | Blocks |
| --- | --- | --- | --- |
| `manifest` | does the declared range admit the version the lockfile installs? | no | **yes**, every push |
| `floors` | which published version is the bottom of each range? | yes | no — reports |
| `floor-overrides` | the `overrides` that pin every sibling to that bottom | yes | no — reports |
| `pin-floors` | write those overrides where this repo's package manager reads them | yes | no — feeds the floor CI leg |
| `install-command` | the install command for this repository's lockfile | no | no |
| `run-command` | the command that runs a package script here | no | no |
| `registry` | does the range still admit the sibling's published `latest`? | yes | **no** |
| `install` | does the tarball install as a consumer, with one copy of each sibling? | yes | **yes**, at release |
| `consumers <pkg> <version>` | who breaks if `<pkg>` publishes `<version>`? | yes | no |
| `impact` | who breaks if THIS checkout publishes what its manifests say? | yes | no |
| `audit` | the same as `registry`, over every package published in the scope | yes | no |

`registry` is the one that catches a range going stale, and it is exactly the one that must not gate
a push. On the day a sibling cuts a major, every repository in the organisation would go red without
anyone having touched anything — and a build that breaks on someone else's release schedule teaches
a team to ignore red, after which none of the others mean anything either.

## What it was built from

Two defects, found on the same afternoon, both in packages that had passed every existing gate:

- `@theokit/di-agent@0.3.0` declared `peer @theokit/sdk: ^1.3.0` while importing `@theokit/sdk/workflow`
  at runtime, three majors after the SDK moved on. `npm i` ended in `ERESOLVE`.
- `@theokit/studio@0.2.0` declared `peer @theokit/agents: ^7.6.0` against a published 11.1.0. This
  one did **not** fail: npm installed two copies of the runtime and hoisted the old one to the root,
  where application code resolved it first.

Both were internally coherent — the peer and the devDependency agreed with each other perfectly, and
both were wrong. That is the reason `manifest` alone is not enough: a repository closed over itself
cannot see this class of defect, by construction.

`test/checks.test.mjs` pins all three historical ranges, including the one `@theokit/studio@0.2.0`
had already corrected by hand once. A detector that cannot detect is worse than none, because green
then means nothing.

## The two directions

Six of the commands run in the **consumer** and therefore fire after the fact: the earliest a
package can learn it was left behind is the moment the sibling has already published.

`consumers` and `impact` run in the **publisher**, before the release. That is the only place the
warning reaches the person who caused the break rather than the one who inherits it, at a moment
when the version number is still a decision. Neither of them fails a job — stranding consumers is
frequently the correct call, and what was missing was never permission, it was knowing who pays.

`audit` runs in neither: it reads the registry, so it sees packages that no repository contains.
That is not hypothetical. It is how five undeprecated packages declaring peers on dead majors were
found (usetheokit/.github#3); no repository's CI could have caught them, because no repository has
their source.

## Usage

```bash
node index.mjs manifest --root ../..            # offline, exits 1 on drift
node index.mjs registry --root ../..            # reports, never exits 1
node index.mjs install  --root ../..            # packs and installs; exits 1 on ERESOLVE or a duplicate
node index.mjs floor-overrides --root ../..     # the overrides that pin every range to its floor
node index.mjs pin-floors --root ../..          # ...and write them where this repo's manager reads them
node index.mjs install-command --root ../..     # pnpm or npm, decided by the lockfile on disk
node index.mjs impact   --root ../..            # who this checkout's versions would strand
node index.mjs consumers @theokit/agents 12.0.0 # who breaks if agents cuts that major
node index.mjs audit                            # every published package in the scope
```

`--json` on any of them for a workflow to read, `--markdown` for an issue body.

## One package manager is not assumed

The install command and the overrides field are both chosen from the **lockfile on disk**, never
from the `packageManager` manifest field, because the two can disagree: `@theokit/skills` declares
`pnpm@10.34.1`, ships a `package-lock.json`, has no `pnpm-lock.yaml`, and runs `npm install` in its
own CI. A gate that trusted the field would run `pnpm install --frozen-lockfile` there and fail on a
repository that is perfectly healthy.

The overrides field differs per manager — `pnpm.overrides`, npm's top-level `overrides`, yarn's
`resolutions` — and writing to the wrong one is **silently ignored**. The floor leg would then
reinstall the same versions, pass, and report a floor it never visited. That is why the choice lives
in a tested module rather than in three lines of YAML.

There are **three** places the manager has to be right, not two: the install, the overrides field,
and the command that runs the suite. The first version of this got two of them and hardcoded
`pnpm test` for the third, which failed on `@theokit/skills` with `pnpm: command not found` — exit
127, in a job whose name said it had run the suite at the bottom of every declared range. It had run
nothing. Detecting the manager in two places out of three is indistinguishable from not detecting
it at all.

## Wiring

A repository adopts the gate with one file, `.github/workflows/dep-check.yml`, calling the reusable
workflow. The expensive legs are off for an ordinary push and on for the release pull request:

```yaml
jobs:
  dep-check:
    uses: usetheokit/shared-workflows/.github/workflows/dep-check.yml@v1
    with:
      run-install-check: ${{ github.base_ref == 'main' }}
      run-floor-check: ${{ github.base_ref == 'main' }}
      run-impact-check: ${{ github.base_ref == 'main' }}
```

`@v1` is a moving major and the tool inside it is not: the YAML may change under callers so one
correction reaches everyone, while `@theokit/dep-check` is pinned to an exact version so a change in
what the detector detects is a version bump somebody reviewed.

What makes it a gate is marking **Dependency Gate / dependency gate** required in branch protection.
A job that runs and reports but is not required blocks nothing.

The organisation-wide sweep is `dep-check-report.yml` in usetheokit/shared-workflows — one scheduled workflow,
not one per repo, because the sweep reads the registry rather than a checkout. It maintains a single
standing issue: rewritten while a broken contract exists, closed automatically when none does.

## What it does not do

It does not open pull requests to move a range forward. Detecting and repairing are different jobs,
and there is a mature tool for the second one.

That is Renovate, configured through the shared preset in
[usetheokit/renovate-config](https://github.com/usetheokit/renovate-config) — the name Renovate
auto-detects, so a repository created next month inherits the policy without anyone wiring it up. A repository opts in with three lines:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["github>usetheokit/renovate-config"]
}
```

The rule the preset exists for is `matchDepTypes: ["peerDependencies"]` with `rangeStrategy: replace`
on our own packages. `replace` rather than `widen` deliberately: we do not test the previous major of
a sibling, so declaring support for it would be a claim nothing backs. Third-party peers — react,
vite — get `widen` instead, because dropping a major that still works narrows our consumers' options
for nothing.

Dependabot cannot do this. It does not look at peerDependencies for npm at all
([dependabot-core#1242](https://github.com/dependabot/dependabot-core/issues/1242), open since 2019),
which is why the organisation's existing Dependabot configuration could not have caught either defect
no matter how it was tuned.

**Renovate must be installed on the organisation for any of that to run.** The config files are inert
until the app is granted access — that is a one-time action in GitHub's UI, not something a commit
can do.
