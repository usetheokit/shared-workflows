/**
 * Everything that talks to the npm registry.
 *
 * Isolated from `checks.mjs` for one reason: the decision logic has to be provable
 * against the defects it exists to catch, and a function that reaches the network
 * cannot be tested by asserting on a range. What lives here is I/O and nothing else
 * — no judgement about what a version means.
 *
 * Uses the registry HTTP API rather than shelling out to `npm view`, because one
 * packument answers every question about a package at once and a subprocess per
 * question turns a 13-package sweep into 40 spawns.
 */
const REGISTRY = process.env.NPM_REGISTRY ?? "https://registry.npmjs.org";

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (response.status === 404) return null;
  if (!response.ok) {
    // Fail loud. A gate that treats a 503 as "no drift found" reports clean on the
    // day the registry is down, which is worse than not running at all.
    throw new Error(`registry ${response.status} ${response.statusText} for ${url}`);
  }
  return response.json();
}

/** The full packument: every published version and its manifest. */
export async function packument(name) {
  return getJson(`${REGISTRY}/${encodeURIComponent(name)}`);
}

/** The version behind the `latest` dist-tag, or null when nothing is published. */
export async function latestVersion(name) {
  const doc = await packument(name);
  return doc?.["dist-tags"]?.latest ?? null;
}

/** Every published version, in registry order. */
export async function publishedVersions(name) {
  const doc = await packument(name);
  return Object.keys(doc?.versions ?? {});
}

/**
 * The unscoped packages this organisation publishes. The `@theokit` scope carries
 * its own guarantee — npm will not let anyone else publish into it — but these two
 * names have to be listed, and a name added here is a name nobody else can take.
 */
const UNSCOPED_ECOSYSTEM_PACKAGES = ["theokit", "create-theokit"];

/**
 * Keep the ecosystem's own packages out of a full-text search result.
 *
 * The registry search API does not honour a `scope:` qualifier — `text=scope:theokit`
 * returns zero results while `text=@theokit` returns every package — so the query is
 * full text and the filtering happens here. Without this, any third-party package
 * whose README mentions theokit would be swept in and asked about its peers.
 */
export function keepEcosystemPackages(names) {
  return [...new Set(names.filter((n) => n?.startsWith("@theokit/") || UNSCOPED_ECOSYSTEM_PACKAGES.includes(n)))].sort();
}

/**
 * Which packages this organisation publishes.
 *
 * Discovered from the registry rather than kept in a list, because a hand-kept list
 * of an ecosystem that gains a package every few weeks is wrong within a month —
 * and a reverse check that silently omits a consumer is worse than no reverse check,
 * since it reports "nobody breaks" with authority.
 */
export async function discoverEcosystemPackages() {
  const doc = await getJson(`${REGISTRY}/-/v1/search?text=%40theokit&size=250`);
  const names = (doc?.objects ?? []).map((o) => o?.package?.name);
  return keepEcosystemPackages([...names, ...UNSCOPED_ECOSYSTEM_PACKAGES]);
}

/**
 * Every published package that declares a dependency on `target`, with the range it
 * declares. Reads the `latest` manifest of each ecosystem package.
 */
export async function consumersOf(target, { depTypes = ["peerDependencies", "dependencies"] } = {}) {
  const names = await discoverEcosystemPackages();
  const consumers = [];
  for (const name of names) {
    if (name === target) continue;
    const doc = await packument(name);
    const latest = doc?.["dist-tags"]?.latest;
    const manifest = latest ? doc.versions[latest] : null;
    if (!manifest) continue;
    for (const depType of depTypes) {
      const range = manifest[depType]?.[target];
      if (range) consumers.push({ pkg: name, version: latest, depType, range });
    }
  }
  return consumers;
}
