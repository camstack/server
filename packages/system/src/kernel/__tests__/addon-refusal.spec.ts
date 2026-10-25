import { describe, expect, it } from 'vitest'
import { AddonRefusedError, findAddonRefusal } from '../addon-refused-error.js'
import {
  formatRunnerRefusalLine,
  parseRunnerRefusals,
  refusalReportOf,
} from '../moleculer/runner-refusal.js'

/** A deterministic Init refusal, as an addon's own subclass would declare it. */
class FixtureRefusal extends AddonRefusedError {
  constructor(addonId: string, what: string) {
    super('fixture-refusal', `addon "${addonId}" refuses to start: ${what}`, 'Fix the fixture.')
    this.name = 'FixtureRefusal'
  }
}

describe('AddonRefusedError (D877)', () => {
  it('a subclass IS a typed refusal, found through a wrapping cause', () => {
    const refusal = new FixtureRefusal('auth', 'per-device blobs')
    expect(refusal).toBeInstanceOf(AddonRefusedError)
    const wrapped = new Error('init failed', { cause: refusal })
    expect(findAddonRefusal(wrapped)).toBe(refusal)
    expect(findAddonRefusal(new Error('boom'))).toBeNull()
  })

  it('round-trips through the stdout line and ignores everything else', () => {
    const err = new FixtureRefusal('auth', 'x')
    const line = formatRunnerRefusalLine('hub/auth', refusalReportOf('auth', err))
    expect(line.endsWith('\n')).toBe(true)
    const parsed = parseRunnerRefusals(
      'hub/auth',
      `noise\n${line}READY:hub/auth\nREFUSED:hub/auth:{torn`,
    )
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({ addonId: 'auth', code: 'fixture-refusal' })
    // another node's line is not ours
    expect(parseRunnerRefusals('hub/other', line)).toHaveLength(0)
  })
})
