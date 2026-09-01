# @theokit/release-channel

Refuses a release whose **declared** channel and **actual** changesets prerelease state disagree.

```bash
npx @theokit/release-channel          # run from the repository root
```

```
release-channel: Declared `next`, and changesets is in prerelease mode on `next`.
```

## The failure it exists for

`changeset pre exit` — or a bad merge, or a conflict resolved the wrong way — removes
`.changeset/pre.json`. Nothing errors. The next release publishes a **stable** version, moves the
`latest` dist-tag for every consumer, and reports success.

There is no signal in that sequence. The guard adds one.

## Two facts that must agree

| Fact | Where | What it is |
|---|---|---|
| the declaration | `"releaseChannel"` in the root `package.json` | a sentence a reviewer reads in a diff |
| the state | `.changeset/pre.json` | what `changeset version` will actually produce |

Asserting only "prerelease mode is on" cannot express *cutting a stable release*, so the guard would
have to be switched off on the one day it matters most — which is how a gate stops existing.
Requiring the two to **agree** keeps the exit available and makes it deliberate: it takes an edit to
the manifest, in the same pull request, where somebody sees it.

## Cutting a stable release

Two edits, one pull request:

```bash
pnpm changeset pre exit          # removes prerelease mode
# and set "releaseChannel": "latest" in the root package.json
```

Neither works alone. Doing one without the other is exactly what the guard reports.

## Verdicts

| code | meaning | exit |
|---|---|---|
| `pre` | declared a prerelease channel, and prerelease mode is on that channel | 0 |
| `stable` | declared `latest`, and prerelease mode is off | 0 |
| `pre_mode_missing` | declared a prerelease channel, `pre.json` is gone — **the next release would move `latest`** | 1 |
| `pre_mode_exited` | `pre.json` records `mode: exit` while the declaration still names a channel | 1 |
| `channel_mismatch` | declared one channel, prerelease mode is on another | 1 |
| `still_in_pre_mode` | declared `latest`, prerelease mode still live | 1 |
| `channel_undeclared` | no `releaseChannel` in the manifest | 1 |
| `channel_invalid` | the declared value is not a dist-tag npm accepts | 1 |
| `unreadable` | no manifest, or `pre.json` exists and does not parse | 1 |

A `pre.json` that exists and does not parse is **not** treated as absent. Reporting corruption as
"we are on `latest`" would resolve an unknown in the direction that publishes.

Every failing verdict carries a `hint` naming the command that fixes it, and emits a GitHub Actions
`::error` annotation when `GITHUB_ACTIONS` is set.

## In CI

```yaml
- uses: usetheokit/shared-workflows/actions/release-channel@v1
```

Put it in two places: on every pull request in `ci.yml`, and immediately before the publish step in
`release.yml` — the second for the path that reaches a release without passing through the first.
