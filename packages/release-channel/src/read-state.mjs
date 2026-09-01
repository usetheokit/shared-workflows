import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Reads the two facts off disk. Kept apart from the decision so the decision is testable without a filesystem. */
export function readState(root = process.cwd()) {
  const manifestPath = join(root, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`No package.json at ${root}. Run this from the repository root.`)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

  const prePath = join(root, '.changeset', 'pre.json')
  // Absent is a legitimate state (stable channel), so it is `null` rather than an error. A file that
  // exists and does not parse is NOT absent — reporting it as such would turn corruption into "we
  // are on latest", which is the direction that publishes.
  let pre = null
  if (existsSync(prePath)) {
    try {
      pre = JSON.parse(readFileSync(prePath, 'utf8'))
    } catch (cause) {
      throw new Error(`.changeset/pre.json exists but is not valid JSON: ${cause.message}`)
    }
  }

  return { declared: manifest.releaseChannel ?? null, pre }
}
