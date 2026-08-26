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
  { file: "pnpm-lock.yaml", manager: "pnpm", install: ["pnpm", "install", "--frozen-lockfile"], unlocked: ["pnpm", "install", "--no-frozen-lockfile"], run: ["pnpm", "run"], overridesPath: ["pnpm", "overrides"] },
  { file: "package-lock.json", manager: "npm", install: ["npm", "ci", "--no-audit", "--no-fund"], unlocked: ["npm", "install", "--no-audit", "--no-fund"], run: ["npm", "run"], overridesPath: ["overrides"] },
  { file: "yarn.lock", manager: "yarn", install: ["yarn", "install", "--immutable"], unlocked: ["yarn", "install"], run: ["yarn", "run"], overridesPath: ["resolutions"] },
];

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
