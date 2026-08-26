# shared-workflows

Reusable CI workflows for the Theokit ecosystem, and the tooling they run. One place to correct a
gate instead of eleven that drift.

## What is here

| | |
| --- | --- |
| [`.github/workflows/dep-check.yml`](.github/workflows/dep-check.yml) | The dependency gate. Reusable — a repository calls it. |
| [`.github/workflows/dep-check-report.yml`](.github/workflows/dep-check-report.yml) | The organisation-wide sweep. Scheduled, runs here, opens one standing issue. |
| [`packages/dep-check`](packages/dep-check) | `@theokit/dep-check` — the tool the workflows invoke. |

## Adopting the gate

```yaml
# .github/workflows/dep-check.yml
name: Dependency Gate
on:
  push:
    branches: [main, develop, workspace]
  pull_request:
    branches: [main, develop]
  workflow_dispatch:
    inputs:
      full: { type: boolean, default: false }

permissions:
  contents: read

jobs:
  dep-check:
    uses: usetheokit/shared-workflows/.github/workflows/dep-check.yml@v1
    with:
      run-install-check: ${{ github.base_ref == 'main' || inputs.full == true }}
      run-floor-check: ${{ github.base_ref == 'main' || inputs.full == true }}
      run-impact-check: ${{ github.base_ref == 'main' || inputs.full == true }}
```

Then mark **`dep-check / dependency gate`** required in branch protection. A job that runs and
reports but is not required blocks nothing.

## Two things are versioned here, and they are versioned differently

This is the part worth reading before changing anything.

**The workflow moves with a tag.** `@v1` is a moving major: a fix to the YAML reaches every caller
on their next run, which is the entire reason a reusable workflow exists. Pinning callers to a
commit SHA would mean eleven pull requests to correct one gate, which is how a central policy stops
being central.

**The tool does not move.** `@theokit/dep-check` is pinned to an exact version by the workflow's
`dep-check-version` input, so a behaviour change in the detector is a version bump somebody
reviewed — not something that arrives overnight because the tool's main branch moved. The pin lives
in one file here rather than in eleven callers.

That split is deliberate. The failure it prevents: a detector silently changing what it detects is
indistinguishable from the codebase changing, and the green that follows is believed either way.

The organisation-wide sweep is the exception — it runs the tool from **this checkout**, not the
published version, so a defect in the detector surfaces in our own report before it is pinned into
eleven repositories.

## Releasing the tool

Tag `dep-check-v<version>` after bumping `packages/dep-check/package.json`. The release workflow
verifies that the tag and the manifest agree before publishing — a tag saying `v0.2.0` on a manifest
saying `0.1.0` publishes `0.1.0` and then fails on the next attempt with an error about the wrong
thing, hours after the mistake.

Publishing is npm trusted publishing over OIDC: no secret in this repository, nothing to rotate, and
every tarball carries a provenance attestation linking it to the commit and workflow that built it.

## Why this repository exists at all

The gate lived in `usetheokit/.github` first. That works — `uses:` resolves from any repository —
but it is not what `.github` is for: GitHub inherits *community health files* from there
(CONTRIBUTING, SECURITY, issue templates, the profile README), and **workflows are not among them**.
Nothing was inherited; it was an explicit reference to a repository that happened to have that name,
mixed in with the organisation's public profile.

It also had a concrete cost. `usetheokit/.github` has a single branch, `workspace`, so the callers
could not use the `@main` everyone writes by default — and a `uses:` naming a branch that does not
exist fails at workflow *resolution*, before any step runs, with an error about the workflow rather
than about dependencies. Eleven repositories nearly shipped a gate that never ran while looking
exactly like a gate that passed.
