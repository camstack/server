/**
 * Accessory children of a camera on a lossy link rotated ids (#666 follow-up,
 * camera 3628 on 2026-11-23). `getDeviceCapabilities` reads SupportInfo and
 * AbilityInfo with `Promise.allSettled`: when either times out, the lib
 * computes the flags from what is left and every accessory reads `false`.
 * Two such probes 24 s apart (11:55:04 and 11:55:28 UTC) were classified as a
 * definitive list without the Siren, the kernel pruned the child, and the next
 * full probe re-created it under a new id.
 *
 * D49: a partial read is not evidence of absence. It may ADD a flag it saw,
 * never retract one, and until a full read lands this session the accessory
 * answer is `unknown` (spawns, never prunes).
 */
import type { AccessoryChildSpec } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  abilityReadQuality,
  accessoryChildrenAnswerFor,
  mergeAbilityRead,
} from '../accessory-probe-flags'

const SIREN: AccessoryChildSpec = {
  stableIdSuffix: 'acc-siren',
  meta: { type: 'siren', name: 'cam Siren' },
  config: {},
  factory: () => {
    throw new Error('not built here')
  },
} as unknown as AccessoryChildSpec

const KNOWN = { hasSiren: true, hasFloodlight: true, hasPirSensor: true, hasIntercom: true }
/** What the lib computed at 11:55:28 UTC with one of its two sources missing. */
const DEGRADED = {
  hasSiren: false,
  hasFloodlight: false,
  hasPirSensor: false,
  hasIntercom: false,
  hasPtz: false,
}

describe('abilityReadQuality', () => {
  it('is full only when both SupportInfo and AbilityInfo answered', () => {
    expect(abilityReadQuality({ abilitiesAvailable: true, supportAvailable: true })).toBe('full')
    expect(abilityReadQuality({ abilitiesAvailable: false, supportAvailable: true })).toBe(
      'partial',
    )
    expect(abilityReadQuality({ abilitiesAvailable: true, supportAvailable: false })).toBe(
      'partial',
    )
    expect(abilityReadQuality(undefined)).toBe('partial')
  })
})

describe('mergeAbilityRead', () => {
  it('a partial read never retracts a flag a previous read established', () => {
    const merged = mergeAbilityRead(KNOWN, DEGRADED, 'partial')
    expect(merged).toMatchObject(KNOWN)
  })

  it('a partial read may add a flag it positively saw', () => {
    expect(
      mergeAbilityRead({ hasSiren: true }, { hasPtz: true, hasSiren: false }, 'partial'),
    ).toEqual({
      hasSiren: true,
      hasPtz: true,
    })
  })

  it('a full read is authoritative, false included', () => {
    expect(mergeAbilityRead(KNOWN, DEGRADED, 'full')).toMatchObject(DEGRADED)
  })

  it('returns a new object and leaves the previous flags untouched', () => {
    const prev = { hasSiren: true }
    const merged = mergeAbilityRead(prev, { hasSiren: false }, 'full')
    expect(merged).not.toBe(prev)
    expect(prev).toEqual({ hasSiren: true })
  })
})

describe('accessoryChildrenAnswerFor after partial reads only', () => {
  it('two degraded probes in a row cannot produce a shrink', () => {
    const afterFirst = mergeAbilityRead(KNOWN, DEGRADED, 'partial')
    const afterSecond = mergeAbilityRead(afterFirst, DEGRADED, 'partial')
    expect(afterSecond.hasSiren).toBe(true)
  })

  it('is unknown while no full ability read has landed this session', () => {
    expect(accessoryChildrenAnswerFor(true, { hasSiren: false }, [], false)).toMatchObject({
      kind: 'unknown',
    })
  })

  it('is complete once a full read landed this session', () => {
    expect(accessoryChildrenAnswerFor(true, { hasSiren: true }, [SIREN], true)).toEqual({
      kind: 'complete',
      children: [SIREN],
    })
  })
})
