/**
 * The ghost Floodlight child: the probe said `hasFloodlight:false`, but the
 * legacy bare-array answer was `unknown` whenever the parent was offline, so
 * the kernel never reconciled. A probe that completed this session answers
 * `complete`; a cache-only restore stays `unknown` (spawns, never prunes).
 */
import type { AccessoryChildSpec } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { accessoryChildrenAnswerFor } from '../accessory-probe-flags'

const SPEC: AccessoryChildSpec = {
  stableIdSuffix: 'acc-siren',
  meta: { type: 'siren', name: 'cam Siren' },
  config: {},
  factory: () => {
    throw new Error('not built here')
  },
} as unknown as AccessoryChildSpec

describe('accessoryChildrenAnswerFor', () => {
  it('a probe completed this session is a definitive read', () => {
    expect(accessoryChildrenAnswerFor(true, { hasSiren: true }, [SPEC])).toEqual({
      kind: 'complete',
      children: [SPEC],
    })
  })

  it('a cache-only restore (or no probe) is unknown but still lists what may spawn', () => {
    const answer = accessoryChildrenAnswerFor(false, { hasSiren: true }, [SPEC])
    expect(answer).toMatchObject({ kind: 'unknown', known: [SPEC] })
  })

  it('a probed slice WITHOUT ability flags (capabilities read failed) is unknown, never complete', () => {
    expect(accessoryChildrenAnswerFor(true, {}, [])).toMatchObject({ kind: 'unknown' })
    expect(accessoryChildrenAnswerFor(true, { hasPtz: true }, [])).toMatchObject({
      kind: 'unknown',
    })
  })
})
