/**
 * The still-mint refusal vocabulary, and the ONE thing a client may not do
 * with it: classify it.
 *
 * The mint route answers 204 with a reason. Two of those reasons mean "you are
 * in the queue, come back" and the rest mean "this will not happen". A client
 * that decides which is which by pattern-matching the server's prose drifts
 * the first time a word changes — and it already had: the route sends
 * `queue-full: 16 thumbnail mints already waiting for host 192.168.1.…` and
 * the surface's table is keyed by the bare token, so EVERY refusal fell
 * through to `Refused: <prose>` and every deferred one latched forever.
 *
 * So the wire carries the distinction: a CODE (the token, on its own) and a
 * DISPOSITION (`deferred` | `final`), each decided by the branch that refused.
 */
import { describe, expect, it } from 'vitest'
import {
  CLIP_STILL_DISPOSITION_HEADER,
  CLIP_STILL_REASON_CODE_HEADER,
  CLIP_STILL_REASON_HEADER,
  ClipSchema,
  ClipStillDispositionSchema,
  ClipStillRefusalCodeSchema,
} from '../capabilities/videoclips.cap.js'

describe('the still-refusal vocabulary', () => {
  it('names every refusal the provider can produce', () => {
    expect(new Set(ClipStillRefusalCodeSchema.options)).toEqual(
      new Set([
        'queue-full',
        'camera-backoff',
        'sleeping',
        'camera-refused',
        'no-keyframe',
        'decode-failed',
        'no-catalog-row',
        'unsupported',
        'unknown-device',
        'uid-missing',
      ]),
    )
  })

  it('carries the deferred/final split on the wire, not in a client table', () => {
    expect(ClipStillDispositionSchema.options).toEqual(['deferred', 'final'])
  })

  it('keeps the prose header it already had, and adds the two that are parseable', () => {
    expect(CLIP_STILL_REASON_HEADER).toBe('x-camstack-reason')
    expect(CLIP_STILL_REASON_CODE_HEADER).toBe('x-camstack-reason-code')
    expect(CLIP_STILL_DISPOSITION_HEADER).toBe('x-camstack-disposition')
  })
})

describe('a clip that is still being written', () => {
  it('says so, rather than letting a frozen index entry pass as an end', () => {
    const parsed = ClipSchema.parse({
      id: 'native:reolink:onboard:0:abc',
      source: 'native:reolink:onboard',
      kind: 'native',
      timeRange: { startMs: 1_789_925_367_000, endMs: 1_789_925_396_000 },
      inProgress: true,
    })
    expect(parsed.inProgress).toBe(true)
  })

  it('leaves the flag ABSENT on a finished clip — absent is the common case', () => {
    const parsed = ClipSchema.parse({
      id: 'native:reolink:onboard:0:abc',
      source: 'native:reolink:onboard',
      kind: 'native',
      timeRange: { startMs: 1, endMs: 2 },
    })
    expect(parsed.inProgress).toBeUndefined()
  })
})
