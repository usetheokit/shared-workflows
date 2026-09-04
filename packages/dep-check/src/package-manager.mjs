/**
 * Which package manager a repository actually uses, and where an override belongs.
 *
 * Detected from the lockfile on disk rather than from the `packageManager` field,
 * because the two can disagree and the lockfile is the one that decides what an
 * install does. `theokit-skills` declares `packageManager: pnpm@10.34.1`, ships a
 * `package-lock.json`, has no `pnpm-lock.yaml`, and its CI runs `npm install` — a gate
 * trusting the manifest there would run `pnpm install --frozen-lockfile` and fail on a
 * repository that is perfectly healthy.
 *
 * Overrides go in different places, which is the other half of why this is a module
 * rather than three lines of shell: npm reads a top-level `overrides`, pnpm reads
 * `pnpm.overrides`, and writing to the wrong one is silently ignored — the floor leg
 * would then reinstall the same versions and pass, reporting that a range was verified
 * at a bottom it never visited.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOCKFILES = [
  { file: "pnpm-lock.yaml", manager: "pnpm", install: ["pnpm", "install", "--frozen-lockfile"], unlocked: ["pnpm", "install", "--no-frozen-lockfile"], run: ["pnpm", "run"], filtered: (pkg) => ["pnpm", "--filter", pkg, "run"], filteredWithDeps: (pkg) => ["pnpm", "--filter", `${pkg}...`, "run"], overridesPath: ["pnpm", "overrides"] },
  { file: "package-lock.json", manager: "npm", install: ["npm", "ci", "--no-audit", "--no-fund"], unlocked: ["npm", "install", "--no-audit", "--no-fund"], run: ["npm", "run"], filtered: (pkg) => ["npm", "run", "--workspace", pkg], filteredWithDeps: (pkg) => ["npm", "run", "--workspace", pkg], overridesPath: ["overrides"] },
  { file: "yarn.lock", manager: "yarn", install: ["yarn", "install", "--immutable"], unlocked: ["yarn", "install"], run: ["yarn", "run"], filtered: (pkg) => ["yarn", "workspace", pkg, "run"], filteredWithDeps: (pkg) => ["yarn", "workspace", pkg, "run"], overridesPath: ["resolutions"] },
];

/**
 * One invocation that builds several packages and their workspace dependencies, or `null` when
 * this package manager has no verified multi-package form.
 *
 * The floor leg builds every package that claims the floor. Doing it one `--filter` at a time
 * re-plans the task graph once per package and rebuilds the shared dependencies each round.
 *
 * Measured on `theokit-plugins`, whose leg claims 10 packages, cold cache, two rounds each:
 *
 *   sequential (10 invocations)   35.2s, 39.6s
 *   batched    (1 invocation)     23.4s, 24.0s
 *
 * -34% and -39%, and the batched run produces the same 10 `dist/` directories.
 *
 * NULL RATHER THAN A GUESS for npm and yarn. npm has no `...` equivalent — its `filteredWithDeps`
 * is already the same as `filtered` — and yarn's `yarn workspace <pkg> run` takes exactly one
 * name, so batching there means `workspaces foreach`, a different command with different
 * semantics that nobody here has measured. The caller keeps its loop, which is correct if slower.
 * A batch that silently built the wrong set would be worse than the time it saved.
 *
 * An empty list is `null` too: `pnpm run build` with no filter builds the WHOLE workspace, which
 * is the defect the per-package filter exists to prevent — packages whose own ranges exclude this
 * floor fail on it.
 */
export function batchedWithDeps(manager, packages) {
  if (!manager || !packages?.length) return null;
  if (manager.file !== "pnpm-lock.yaml") return null;
  const filters = packages.flatMap((pkg) => ["--filter", `${pkg}...`]);
  return ["pnpm", ...filters, "run"];
}

/** Null when no lockfile is present — the caller decides whether that is an error. */
export function detectPackageManager(repoRoot) {
  return LOCKFILES.find((candidate) => existsSync(join(repoRoot, candidate.file))) ?? null;
}

/**
 * Write `overrides` into the repository's root manifest, in the field its package
 * manager reads. Returns what was written so the caller can log it rather than assert
 * it worked.
 */
export function pinOverrides(repoRoot, overrides) {
  const detected = detectPackageManager(repoRoot);
  if (!detected) throw new Error(`no lockfile in ${repoRoot}: cannot tell which package manager to pin for`);
  if (!Object.keys(overrides).length) return { manager: detected.manager, written: {} };

  const manifestPath = join(repoRoot, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  let target = manifest;
  for (const key of detected.overridesPath.slice(0, -1)) {
    target[key] ??= {};
    target = target[key];
  }
  const leaf = detected.overridesPath.at(-1);
  target[leaf] = { ...target[leaf], ...overrides };

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manager: detected.manager, field: detected.overridesPath.join("."), written: overrides };
}

/**
 * The build script this repository runs before its tests, or null if it has none.
 *
 * `build` wins over `build:packages` when both exist: it is the one that produces
 * everything a consumer sees, and a repository needing the narrower one can say so
 * explicitly rather than have the choice guessed.
 */
export function detectBuildScript(repoRoot) {
  const manifestPath = join(repoRoot, "package.json");
  if (!existsSync(manifestPath)) return null;
  const scripts = JSON.parse(readFileSync(manifestPath, "utf8")).scripts ?? {};
  return ["build", "build:packages"].find((name) => scripts[name]) ?? null;
}
