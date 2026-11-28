import type { CamStreamDescriptor } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import {
  HOME_HUB_SESSION_LIMIT_MS,
  STANDALONE_BATTERY_SESSION_LIMIT_MS,
  withSessionLimit,
} from '../session-limit.js'

const DESCRIPTORS: readonly CamStreamDescriptor[] = [
  { camStreamId: 'native:main', kind: 'pull-rfc4571' },
  { camStreamId: 'native:sub', kind: 'pull-rfc4571' },
]

describe('withSessionLimit', () => {
  it('declares a limit under the observed 28 min 07 s for a battery hub child', () => {
    const out = withSessionLimit(DESCRIPTORS, { isHubChild: true, isBattery: true })
    expect(out.map((d) => d.maxSessionMs)).toEqual([
      HOME_HUB_SESSION_LIMIT_MS,
      HOME_HUB_SESSION_LIMIT_MS,
    ])
    expect(HOME_HUB_SESSION_LIMIT_MS).toBeLessThan((28 * 60 + 7) * 1_000)
  })

  it('declares a limit under the observed 1799-1806 s cut for a standalone battery camera', () => {
    const out = withSessionLimit(DESCRIPTORS, { isHubChild: false, isBattery: true })
    expect(out.map((d) => d.maxSessionMs)).toEqual([
      STANDALONE_BATTERY_SESSION_LIMIT_MS,
      STANDALONE_BATTERY_SESSION_LIMIT_MS,
    ])
    expect(STANDALONE_BATTERY_SESSION_LIMIT_MS).toBeLessThan(1_799_000)
  })

  it('declares none for a mains-powered camera or a wired hub child', () => {
    for (const input of [
      { isHubChild: false, isBattery: false },
      { isHubChild: true, isBattery: false },
    ]) {
      expect(withSessionLimit(DESCRIPTORS, input).every((d) => d.maxSessionMs === undefined)).toBe(
        true,
      )
    }
  })
})
