/**
 * Reading the repository under test: which packages it publishes, which siblings
 * each one declares, and which version of a sibling is actually installed.
 *
 * "Actually installed" is the load-bearing part of check A. A manifest can claim any
 * range; only the resolved tree can say what the suite ran against. Resolving it
 * turned out to have four wrong answers before a right one — `theokit-studio`'s
 * `version-floor.test.ts` documents all four — so this file resolves through the
 * package directory rather than through `require`, which is the one route that does
 * not depend on the dependency exporting `./package.json`.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

const DEP_FIELDS = ["peerDependencies", "dependencies"];

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Every publishable package in a repository.
 *
 * `private: true` packages are skipped: they ship nothing, so a range they declare
 * binds no consumer and flagging it is noise. Workspace roots and test fixtures are
 * private for exactly this reason.
 */
export function findPublishablePackages(repoRoot) {
  const found = [];
  const consider = (dir) => {
    const manifestPath = join(dir, "package.json");
    const manifest = readJson(manifestPath);
    if (manifest?.name && !manifest.private) found.push({ dir, manifestPath, manifest });
  };

  consider(repoRoot);
  const packagesDir = join(repoRoot, "packages");
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) consider(join(packagesDir, entry.name));
    }
  }
  return found;
}

/** Every sibling a manifest declares, with the field it was declared in. */
export function siblingReferences(manifest, isSibling) {
  const refs = [];
  for (const field of DEP_FIELDS) {
    for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
      if (isSibling(dep)) refs.push({ field, dep, range });
    }
  }
  return refs;
}

/**
 * The version of `dep` that `fromDir` actually resolves, or null when it resolves
 * nothing — which is the normal case for an optional peer a repository does not
 * install, and must not be reported as drift.
 *
 * Walks node_modules directories upward instead of using `require.resolve` or
 * `import.meta.resolve`: the first needs the dependency to export `./package.json`
 * (most here do not, and the failure looks like a version failure), and the second
 * is unavailable under Vite's SSR transform.
 */
export function resolveInstalledVersion(fromDir, dep) {
  let dir = realpathSync(fromDir);
  for (;;) {
    const candidate = join(dir, "node_modules", dep, "package.json");
    if (existsSync(candidate)) return readJson(candidate)?.version ?? null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
