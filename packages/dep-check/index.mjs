#!/usr/bin/env node
/**
 * dep-check — the ecosystem dependency gate.
 *
 * Four questions, deliberately not collapsed into one, because they differ in what
 * they need in order to be answered and therefore in whether they may fail a build:
 *
 *   manifest   (A) does the declared range admit the version the lockfile installs?
 *                  offline, deterministic — BLOCKING
 *   floors     (B) which published version is the bottom of each range?
 *                  offline — feeds a CI matrix leg that runs the suite there
 *   registry   (C) does the range still admit the sibling's published latest?
 *                  needs the network — REPORTS, never blocks
 *   consumers  (D) who in the ecosystem breaks if this package publishes version X?
 *                  needs the network — run by the publisher, before the major
 *
 * C is the one that catches a range going stale, and it is exactly the one that must
 * not gate a push: on the day a sibling cuts a major, every repository in the
 * organisation would go red without anyone having touched anything. A build that
 * breaks on someone else's release schedule teaches a team to ignore red, and then
 * none of the other three mean anything either.
 */
import { parseArgs } from "node:util";
import { ceilingDrift, consumersLeftBehind, installedDrift, isSibling, rangeFloor, sharedFloor } from "./src/checks.mjs";
import { findPublishablePackages, resolveInstalledVersion, siblingReferences } from "./src/ecosystem.mjs";
import { consumersOf, discoverEcosystemPackages, latestVersion, packument, publishedVersions } from "./src/registry.mjs";
import { detectPackageManager, pinOverrides } from "./src/package-manager.mjs";
import { installFromTarball } from "./src/tarball.mjs";

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: "string", default: "." },
    json: { type: "boolean", default: false },
    markdown: { type: "boolean", default: false },
    unlocked: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});
const [command, ...rest] = positionals;

const USAGE = `dep-check <command> [--root <dir>] [--json]

  manifest                    (A) declared range vs the version actually installed. Exits 1 on drift.
  floors                      (B) the lowest published version each range admits.
  registry                    (C) declared range vs the sibling's published latest. Never exits 1.
  consumers <pkg> <version>   (E) who breaks if <pkg> publishes <version>.
  install                     (D) pack, install as a consumer, assert one copy of each sibling. Exits 1 on failure.
  audit                       every PUBLISHED package in the scope, not only the ones in this checkout.
  impact                      who breaks if THIS checkout publishes the versions in its manifests.
  floor-overrides             the overrides that pin every sibling to the bottom of its range.
  pin-floors                  write those overrides into the repository's manifest, where its
                              package manager reads them. Detected from the lockfile, not the
                              packageManager field — the two can disagree.
  install-command             print the install command for this repository's lockfile.
  run-command <script>        print the command that runs a package script here (default: test).
`;

/**
 * One line per finding — or JSON when a workflow reads it, or markdown when the
 * output is going into an issue body.
 *
 * The markdown form is deliberately not "the text form with pipes". An issue is read
 * by a person deciding whether to act, so it leads with what is broken for consumers
 * and separates it from what is merely a version behind.
 */
function report({ title, findings, columns, note }) {
  if (flags.json) {
    console.log(JSON.stringify({ command, findings }, null, 2));
    return;
  }
  if (flags.markdown) {
    console.log(renderMarkdown({ title, findings, note }));
    return;
  }
  console.log(`\n${title} — ${findings.length} finding${findings.length === 1 ? "" : "s"}`);
  if (note) console.log(note);
  for (const f of findings) console.log("  " + columns(f));
}

/** The issue-body form: what breaks a consumer first, what is merely behind after. */
function renderMarkdown({ title, findings, note }) {
  const contract = findings.filter((f) => f.severity === "contract");
  const behind = findings.filter((f) => f.severity !== "contract");
  const lines = [`## ${title}`, ""];
  if (note) lines.push(note.trim().replace(/^\s+/gm, ""), "");

  if (contract.length) {
    lines.push(
      "### Broken install contract",
      "",
      "A peer range that no longer admits the sibling's published `latest`. A consumer installing",
      "this combination gets an `ERESOLVE` from npm, or — worse, because it is silent — a second",
      "copy of the runtime hoisted above the one the app runs.",
      "",
      "| package | field | sibling | declares | latest | behind |",
      "| --- | --- | --- | --- | --- | --- |",
      ...contract.map((f) => `| \`${f.pkg}\`${f.deprecated ? " *(deprecated)*" : ""} | ${f.field} | \`${f.dep}\` | \`${f.range}\` | ${f.latest} | ${f.majorsBehind} |`),
      "",
    );
  } else {
    lines.push("### Broken install contract", "", "None.", "");
  }

  if (behind.length) {
    lines.push(
      "### Merely behind",
      "",
      "Ordinary dependencies one or more versions back. Renovate's job, not a gate's.",
      "",
      "| package | sibling | declares | latest |",
      "| --- | --- | --- | --- |",
      ...behind.map((f) => `| \`${f.pkg}\` | \`${f.dep}\` | \`${f.range}\` | ${f.latest} |`),
      "",
    );
  }
  return lines.join("\n");
}

/** Every sibling reference in the repository, paired with where it was declared. */
function collectReferences(root) {
  const refs = [];
  for (const pkg of findPublishablePackages(root)) {
    for (const ref of siblingReferences(pkg.manifest, isSibling)) {
      refs.push({ ...ref, pkg: pkg.manifest.name, dir: pkg.dir });
    }
  }
  return refs;
}

async function commandManifest(root) {
  const findings = [];
  for (const ref of collectReferences(root)) {
    const installed = resolveInstalledVersion(ref.dir, ref.dep);
    const drift = installedDrift({ range: ref.range, installed });
    if (drift) findings.push({ ...ref, ...drift });
  }
  report({
    title: "A) declared range vs installed version",
    findings,
    columns: (f) => `${f.pkg.padEnd(28)} ${f.field.padEnd(17)} ${f.dep.padEnd(22)} declares ${f.range} — installed ${f.installed}`,
  });
  return findings.length === 0 ? 0 : 1;
}

async function commandFloors(root) {
  const findings = [];
  for (const ref of collectReferences(root)) {
    const floor = rangeFloor(ref.range, await publishedVersions(ref.dep));
    if (floor) findings.push({ ...ref, floor });
  }
  report({
    title: "B) the bottom of each declared range",
    findings,
    note: "  Run the suite against these, not only against latest. A range is a claim about an interval.",
    columns: (f) => `${f.pkg.padEnd(28)} ${f.dep.padEnd(22)} ${f.range.padEnd(18)} floor ${f.floor}`,
  });
  return 0;
}

async function commandRegistry(root) {
  const refs = collectReferences(root);
  const latest = new Map();
  for (const { dep } of refs) {
    if (!latest.has(dep)) latest.set(dep, await latestVersion(dep));
  }
  const findings = [];
  for (const ref of refs) {
    const drift = ceilingDrift({ range: ref.range, latest: latest.get(ref.dep) });
    if (drift) findings.push({ ...ref, ...drift, severity: ref.field === "peerDependencies" ? "contract" : "behind" });
  }
  // A stale peer is a broken install contract for every consumer; a stale dependency
  // is just being a version behind, which is ordinary and what Renovate is for.
  findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "contract" ? -1 : 1));
  report({
    title: "C) declared range vs published latest",
    findings,
    note: "  `contract` = a peer range that no longer admits latest: consumers cannot install this combination.\n  `behind`   = an ordinary dependency one or more versions back.",
    columns: (f) => `[${f.severity}] ${f.pkg.padEnd(26)} ${f.dep.padEnd(22)} ${f.range.padEnd(18)} latest ${f.latest} (${f.majorsBehind} major${f.majorsBehind === 1 ? "" : "s"} behind)`,
  });
  return 0; // never blocks — see the header
}

async function commandConsumers([pkg, nextVersion]) {
  if (!pkg || !nextVersion) {
    console.error("consumers needs a package and the version about to be published");
    return 2;
  }
  const consumers = await consumersOf(pkg);
  const findings = consumersLeftBehind({ consumers, nextVersion }).map((c) => ({ ...c, nextVersion }));
  report({
    title: `D) consumers left behind by ${pkg}@${nextVersion}`,
    findings,
    note: `  Checked ${consumers.length} published consumer${consumers.length === 1 ? "" : "s"} of ${pkg}.`,
    columns: (f) => `[${f.direction}] ${f.pkg.padEnd(26)} ${f.depType.padEnd(17)} declares ${f.range} — excludes ${nextVersion}`,
  });
  return 0; // informational by design: the release decides, this only tells it who pays
}

async function commandInstall(root) {
  const findings = [];
  for (const pkg of findPublishablePackages(root)) {
    const siblings = siblingReferences(pkg.manifest, isSibling)
      .filter((r) => r.field === "peerDependencies" && !/^(workspace|link|file|portal):/.test(r.range))
      .map((r) => `${r.dep}@latest`);
    const result = installFromTarball({ packageDir: pkg.dir, repoRoot: root, alsoInstall: siblings });
    if (!result.installed) {
      findings.push({ pkg: pkg.manifest.name, problem: result.reason, detail: result.detail });
    } else if (result.duplicates.length) {
      // The silent failure: it installed, and the tree has two runtimes in it.
      for (const d of result.duplicates) {
        findings.push({ pkg: pkg.manifest.name, problem: `two copies of ${d.dep}`, detail: d.versions.join(" and ") });
      }
    }
  }
  report({
    title: "D) install the tarball as a consumer would",
    findings,
    note: "  Packed with the workspace's own manager and installed with npm — two tools, two reasons.\n  Only pnpm rewrites `workspace:` at pack time, so npm-packed workspace members produce tarballs\n  that install nowhere. And pnpm has defaulted strict-peer-dependencies to false since v8, so\n  installing with it would pass on a broken peer contract no npm user can install.",
    columns: (f) => `${f.pkg.padEnd(28)} ${f.problem}${f.detail ? `\n      ${f.detail.replace(/\n/g, "\n      ")}` : ""}`,
  });
  return findings.length === 0 ? 0 : 1;
}

/**
 * The organisation-wide view: every package PUBLISHED under the scope, whether or not
 * a repository in this checkout owns it.
 *
 * The other commands read a repository, so a package with no repository is invisible
 * to all of them. That is not hypothetical — it is how five undeprecated packages
 * declaring peers on dead majors were found (usetheokit/.github#3). No repository's
 * CI could ever have caught those, because no repository contains them.
 */
async function commandAudit() {
  const names = await discoverEcosystemPackages();
  const latest = new Map();
  for (const n of names) latest.set(n, await latestVersion(n));

  const findings = [];
  for (const name of names) {
    const doc = await packument(name);
    const version = latest.get(name);
    const manifest = version ? doc?.versions?.[version] : null;
    if (!manifest) continue;
    for (const field of ["peerDependencies", "dependencies"]) {
      for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
        if (!isSibling(dep)) continue;
        const drift = ceilingDrift({ range, latest: latest.get(dep) });
        if (drift) {
          findings.push({
            pkg: `${name}@${version}`,
            field,
            dep,
            ...drift,
            deprecated: Boolean(manifest.deprecated),
            severity: field === "peerDependencies" ? "contract" : "behind",
          });
        }
      }
    }
  }
  findings.sort((a, b) => b.majorsBehind - a.majorsBehind);
  report({
    title: "audit) every published package in the scope",
    findings,
    note: `  Swept ${names.length} published packages. \`deprecated\` means the registry already warns people.`,
    columns: (f) => `[${f.severity}]${f.deprecated ? "[deprecated]" : ""} ${f.pkg.padEnd(30)} ${f.field.padEnd(17)} ${f.dep.padEnd(20)} ${f.range.padEnd(16)} latest ${f.latest} (${f.majorsBehind} behind)`,
  });
  return 0;
}

/**
 * The reverse check, pointed at the version this checkout is about to publish.
 *
 * Every other command lives in the consumer and therefore fires after the fact: the
 * earliest a consumer can learn it was left behind is the moment the sibling has
 * already published. This one runs in the publisher's own release pull request, where
 * the number is already decided and someone can still act on who pays for it.
 *
 * Reads the version from the manifest rather than from a git diff, so it needs no
 * base ref and works the same on a release pull request, on a branch, and by hand.
 */
async function commandImpact(root) {
  const findings = [];
  let checked = 0;
  for (const pkg of findPublishablePackages(root)) {
    const { name, version } = pkg.manifest;
    if (!version) continue;
    const consumers = await consumersOf(name);
    checked += consumers.length;
    for (const left of consumersLeftBehind({ consumers, nextVersion: version, direction: "behind" })) {
      findings.push({ publishing: `${name}@${version}`, ...left });
    }
  }
  report({
    title: "who breaks if this checkout publishes what its manifests say",
    findings,
    note: `  Checked ${checked} published consumer declaration${checked === 1 ? "" : "s"}.\n  Informational: a major that leaves consumers behind may well be the right call — this only names who has to move.`,
    columns: (f) => `${f.publishing.padEnd(30)} leaves ${f.pkg.padEnd(26)} ${f.depType.padEnd(17)} declares ${f.range}`,
  });
  return 0;
}

/**
 * Check B, in the form a CI job can consume: the pnpm `overrides` block that pins
 * every sibling to the lowest published version its range admits.
 *
 * A wide range is a promise about an interval, and the devDependency only ever
 * exercises the top of it. Declaring `>=11 <13` while testing 12 exclusively is the
 * same class of claim as declaring `^7.6.0` while testing 7.6.0 — true about one
 * point, asserted about a span. This is what makes the bottom of the span real.
 *
 * When several packages in a workspace declare different ranges for the same sibling,
 * the floor is the bottom of their INTERSECTION. The override is one global value, so
 * it has to be a version all of them admit; pinning the lowest individual floor puts a
 * consumer on a version its own range excludes and then blames it for failing there.
 *
 * A sibling whose declared ranges share no published version is skipped rather than
 * pinned, and reported — the workspace cannot be installed as declared, which is a
 * finding of its own and not something to resolve by picking a side.
 */
async function lowestFloors(root) {
  const ranges = new Map();
  for (const ref of collectReferences(root)) {
    if (!ranges.has(ref.dep)) ranges.set(ref.dep, []);
    ranges.get(ref.dep).push(ref.range);
  }
  const floors = new Map();
  const irreconcilable = [];
  for (const [dep, declared] of ranges) {
    const floor = sharedFloor(declared, await publishedVersions(dep));
    if (floor) floors.set(dep, floor);
    else if (declared.filter((r) => r && !/^(workspace|file|link):/.test(r)).length > 1) {
      irreconcilable.push({ dep, declared });
    }
  }
  for (const { dep, declared } of irreconcilable) {
    console.log(`  note: ${dep} is declared as ${declared.join(" and ")}, which share no published version — not pinned`);
  }
  return Object.fromEntries([...floors.entries()].sort());
}

async function commandFloorOverrides(root) {
  const overrides = await lowestFloors(root);
  if (flags.json) {
    console.log(JSON.stringify(overrides, null, 2));
    return 0;
  }
  console.log("\noverrides pinning every sibling to the bottom of its declared range:\n");
  for (const [dep, version] of Object.entries(overrides)) console.log(`  ${dep.padEnd(24)} ${version}`);
  if (!Object.keys(overrides).length) console.log("  (none — no sibling range in this repository resolves to a published version)");
  return 0;
}

/** The floor overrides, computed and written where this repository's manager reads them. */
async function commandPinFloors(root) {
  const lowest = await lowestFloors(root);
  const result = pinOverrides(root, lowest);
  if (!Object.keys(result.written).length) {
    console.log("no floor to pin — no sibling range in this repository resolves to a published version");
    return 0;
  }
  console.log(`pinned ${Object.keys(result.written).length} sibling(s) under \`${result.field}\` for ${result.manager}:`);
  for (const [dep, version] of Object.entries(result.written)) console.log(`  ${dep.padEnd(24)} ${version}`);
  return 0;
}

/**
 * The install command for this repository, chosen by the lockfile on disk.
 *
 * A workflow that hardcodes `pnpm install --frozen-lockfile` fails on a repository that
 * uses npm, and the failure looks like a dependency problem rather than a wrong guess.
 */
function commandInstallCommand(root, { unlocked = false } = {}) {
  const detected = detectPackageManager(root);
  if (!detected) {
    console.error(`no lockfile in ${root}: cannot tell which package manager this repository uses`);
    return 1;
  }
  console.log((unlocked ? detected.unlocked : detected.install).join(" "));
  return 0;
}

/**
 * The command that runs a package script here — `pnpm test`, `npm run test`, and so on.
 *
 * Exists because detecting the manager for the install and then hardcoding `pnpm test`
 * is the same as not detecting it: the floor leg failed on the ecosystem's one npm
 * repository with `pnpm: command not found`, exit 127, in a job whose name said it had
 * run the suite at the bottom of every declared range. It had run nothing.
 */
function commandRunCommand(root, script) {
  const detected = detectPackageManager(root);
  if (!detected) {
    console.error(`no lockfile in ${root}: cannot tell which package manager this repository uses`);
    return 1;
  }
  console.log([...detected.run, script || "test"].join(" "));
  return 0;
}

const commands = {
  manifest: () => commandManifest(flags.root),
  floors: () => commandFloors(flags.root),
  registry: () => commandRegistry(flags.root),
  install: () => commandInstall(flags.root),
  consumers: () => commandConsumers(rest),
  audit: () => commandAudit(),
  impact: () => commandImpact(flags.root),
  "floor-overrides": () => commandFloorOverrides(flags.root),
  "pin-floors": () => commandPinFloors(flags.root),
  "install-command": () => commandInstallCommand(flags.root, { unlocked: flags.unlocked }),
  "run-command": () => commandRunCommand(flags.root, rest[0]),
};

if (flags.help || !command || !commands[command]) {
  console.log(USAGE);
  process.exit(command && !commands[command] ? 2 : 0);
}
process.exit(await commands[command]());
