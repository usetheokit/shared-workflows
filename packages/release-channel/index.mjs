#!/usr/bin/env node
import { checkReleaseChannel } from './src/check.mjs'
import { readState } from './src/read-state.mjs'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const rootFlag = args.indexOf('--root')
const root = rootFlag === -1 ? process.cwd() : args[rootFlag + 1]

let result
try {
  result = checkReleaseChannel(readState(root))
} catch (error) {
  result = { ok: false, code: 'unreadable', message: error.message }
}

if (asJson) {
  console.log(JSON.stringify(result, null, 2))
} else if (result.ok) {
  console.log(`release-channel: ${result.message}`)
} else {
  console.error(`release-channel: ${result.message}`)
  if (result.hint) console.error(`\n${result.hint}`)
  if (process.env.GITHUB_ACTIONS) {
    const flat = `${result.message} ${result.hint ?? ''}`.replace(/\n/g, ' ').trim()
    console.error(`::error title=Release channel (${result.code})::${flat}`)
  }
}

process.exit(result.ok ? 0 : 1)
