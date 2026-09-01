import { describe, expect, it } from 'vitest'
import { checkReleaseChannel } from '../src/check.mjs'

const pre = (tag) => ({ mode: 'pre', tag, initialVersions: {}, changesets: [] })
const exited = (tag) => ({ mode: 'exit', tag, initialVersions: {}, changesets: [] })

describe('the channel is declared and matches', () => {
  it('passes on a prerelease channel whose pre mode agrees', () => {
    const r = checkReleaseChannel({ declared: 'next', pre: pre('next') })
    expect(r.ok).toBe(true)
    expect(r.code).toBe('pre')
  })

  it('passes on latest when there is no pre.json', () => {
    const r = checkReleaseChannel({ declared: 'latest', pre: null })
    expect(r.ok).toBe(true)
    expect(r.code).toBe('stable')
  })

  it('passes on latest when pre.json records an exited mode', () => {
    // `changeset pre exit` leaves the file behind with mode: exit. That is a finished exit, not a
    // half-finished one, so it must not read as a failure.
    const r = checkReleaseChannel({ declared: 'latest', pre: exited('next') })
    expect(r.ok).toBe(true)
    expect(r.code).toBe('stable')
  })
})

describe('the failure this guard exists for', () => {
  it('fails when the channel is a prerelease and pre.json vanished', () => {
    const r = checkReleaseChannel({ declared: 'next', pre: null })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('pre_mode_missing')
    expect(r.hint).toContain('pnpm changeset pre enter next')
  })

  it('says what would happen, not just that something is wrong', () => {
    const r = checkReleaseChannel({ declared: 'next', pre: null })
    expect(r.hint).toMatch(/latest/)
    expect(r.hint).toMatch(/report success/)
  })

  it('fails when pre mode was exited but the declaration still says the channel', () => {
    const r = checkReleaseChannel({ declared: 'next', pre: exited('next') })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('pre_mode_exited')
  })
})

describe('drift in the other direction', () => {
  it('fails when latest is declared while pre mode is live', () => {
    const r = checkReleaseChannel({ declared: 'latest', pre: pre('next') })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('still_in_pre_mode')
  })

  it('fails when the declared channel and the pre tag disagree', () => {
    const r = checkReleaseChannel({ declared: 'next', pre: pre('beta') })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('channel_mismatch')
    expect(r.message).toContain('beta')
  })
})

describe('the declaration itself', () => {
  it.each([null, undefined, ''])('fails when it is %s, rather than defaulting', (declared) => {
    const r = checkReleaseChannel({ declared, pre: pre('next') })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('channel_undeclared')
  })

  it.each(['Next', '1.2.3', 'next!', '-next', ''])('rejects %o as a dist-tag', (declared) => {
    const r = checkReleaseChannel({ declared, pre: pre('next') })
    expect(r.ok).toBe(false)
  })

  it('accepts a hyphenated channel name', () => {
    const r = checkReleaseChannel({ declared: 'release-candidate', pre: pre('release-candidate') })
    expect(r.ok).toBe(true)
  })
})

describe('every failure is actionable', () => {
  const failures = [
    { declared: 'next', pre: null },
    { declared: 'next', pre: exited('next') },
    { declared: 'next', pre: pre('beta') },
    { declared: 'latest', pre: pre('next') },
    { declared: null, pre: pre('next') },
    { declared: '1.0.0', pre: pre('next') },
  ]
  it.each(failures)('names a next step for %o', (state) => {
    const r = checkReleaseChannel(state)
    expect(r.ok).toBe(false)
    expect(r.hint, `${r.code} has no hint`).toBeTruthy()
    expect(r.hint.length).toBeGreaterThan(20)
  })
})
