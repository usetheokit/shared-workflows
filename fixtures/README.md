# fixtures

A minimal repository shape the setup action can be exercised against in CI.

It exists because the action's job is to produce a tree, and the only way to know it produced the
right one is to install into it and look. The fixture declares `packageManager: pnpm@10.34.1` and a
`.nvmrc` of 22.12.0 — so a run can assert that the action resolved *the declared* manager rather
than whatever the runner had, which is exactly the divergence that left `theokit-sdk` validating
under pnpm 9 for months (usetheokit/theokit-sdk#415).
