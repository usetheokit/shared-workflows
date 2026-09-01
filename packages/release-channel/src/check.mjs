/**
 * Does the release channel this repository DECLARES still match the state changesets is actually in?
 *
 * Two facts have to agree, and neither is enough on its own:
 *
 *   - `releaseChannel` in the root manifest — a human sentence, visible in any diff
 *   - `.changeset/pre.json` — the machine state that decides what `changeset version` produces
 *
 * They drift in one direction silently and expensively. `changeset pre exit` (or a bad merge, or a
 * conflict resolved the wrong way) removes `pre.json`; nothing errors; the next release publishes a
 * STABLE version and moves the `latest` dist-tag for every consumer. The publish reports success.
 *
 * Asserting only "pre mode is on" — the shape a caller reaches for first — cannot express cutting a
 * stable release, so the guard would have to be disabled on the one day it matters most, which is
 * how a gate stops existing. Requiring the two to AGREE keeps the exit available and makes it
 * deliberate: it takes an edit to the manifest, in the same pull request, where a reviewer sees it.
 */

/** A dist-tag npm will accept. It refuses anything that parses as a semver version. */
const CHANNEL_SHAPE = /^[a-z][a-z0-9-]*$/

/** The one channel name that means "no prerelease mode". */
export const STABLE = 'latest'

/**
 * @param {{declared: string|null|undefined, pre: {mode?: string, tag?: string}|null|undefined}} state
 * @returns {{ok: boolean, code: string, message: string, hint?: string}}
 */
export function checkReleaseChannel({ declared, pre }) {
  if (declared === null || declared === undefined || declared === '') {
    return {
      ok: false,
      code: 'channel_undeclared',
      message: 'The repository does not declare a release channel.',
      hint: 'Add "releaseChannel": "next" (or "latest") to the root package.json. Absence cannot be a default here: a guard that passes when the declaration is missing is opt-out by omission.',
    }
  }

  if (typeof declared !== 'string' || !CHANNEL_SHAPE.test(declared)) {
    return {
      ok: false,
      code: 'channel_invalid',
      message: `"${declared}" is not a usable dist-tag.`,
      hint: 'A dist-tag is lowercase, starts with a letter, and holds only letters, digits and hyphens. npm refuses a tag that parses as a semver version.',
    }
  }

  const inPreMode = Boolean(pre) && pre.mode === 'pre'

  if (declared === STABLE) {
    if (!pre) return { ok: true, code: 'stable', message: 'Declared `latest`, and changesets is not in prerelease mode.' }
    if (!inPreMode) return { ok: true, code: 'stable', message: 'Declared `latest`, and `.changeset/pre.json` records an exited mode.' }
    return {
      ok: false,
      code: 'still_in_pre_mode',
      message: `Declared \`latest\`, but changesets is still in prerelease mode on \`${pre.tag}\`.`,
      hint: 'Run `pnpm changeset pre exit` and commit the result, or set releaseChannel back to the prerelease channel. Publishing in this state would put a prerelease version behind the `latest` dist-tag.',
    }
  }

  if (!pre) {
    return {
      ok: false,
      code: 'pre_mode_missing',
      message: `Declared \`${declared}\`, but \`.changeset/pre.json\` is absent — changesets is NOT in prerelease mode.`,
      hint: `The next release would publish a stable version and move the \`latest\` dist-tag for every consumer, and it would report success. Run \`pnpm changeset pre enter ${declared}\` and commit \`.changeset/pre.json\`. If cutting a stable release IS the intent, set "releaseChannel": "latest" in the same pull request.`,
    }
  }

  if (!inPreMode) {
    return {
      ok: false,
      code: 'pre_mode_exited',
      message: `Declared \`${declared}\`, but \`.changeset/pre.json\` records mode \`${pre.mode}\` rather than \`pre\`.`,
      hint: `Run \`pnpm changeset pre enter ${declared}\`, or declare "releaseChannel": "latest" if the exit was intended.`,
    }
  }

  if (pre.tag !== declared) {
    return {
      ok: false,
      code: 'channel_mismatch',
      message: `Declared \`${declared}\`, but prerelease mode is on \`${pre.tag}\`.`,
      hint: `Versions would publish under the \`${pre.tag}\` dist-tag while everything written down says \`${declared}\`. Exit and re-enter on the intended channel, or correct the declaration.`,
    }
  }

  return { ok: true, code: 'pre', message: `Declared \`${declared}\`, and changesets is in prerelease mode on \`${declared}\`.` }
}
