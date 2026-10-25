/**
 * The day/night flag a retrain frame carries into the export manifest.
 *
 * Source of truth, in order (D785): the frame's own pixels (a chromatically
 * flat frame is IR — the IR-cut is out), then the sun at the SITE's
 * coordinates at the frame's capture time, then the coarse UTC clock. The
 * same layered resolver the scene monitor uses; this only adds WHICH layer
 * answered, because a trainer splitting metrics by day/night must be able to
 * tell a measured IR frame from an almanac guess.
 */
import { describe, expect, it } from 'vitest'
import { IR_CHROMA_THRESHOLD } from '../../scene/condition-resolver.js'
import { retrainFrameLighting } from '../retrain-lighting.js'

/** Turin — the operator's site is in Italy. */
const SITE = { lat: 45.07, lng: 7.69 }
/** 2026-06-21 12:00 local (10:00 UTC) and 01:00 local (23:00 UTC the day before). */
const NOON = Date.UTC(2026, 5, 21, 10, 0)
const NIGHT = Date.UTC(2026, 5, 20, 23, 0)

describe('retrain frame lighting', () => {
  it('a flat frame is IR whatever the clock says — the pixels win', () => {
    expect(
      retrainFrameLighting({
        capturedAt: NOON,
        chromaSpread: IR_CHROMA_THRESHOLD - 1,
        coordinates: SITE,
      }),
    ).toEqual({ condition: 'ir', night: true, source: 'ir-chroma' })
  })

  it('a colour frame falls through to the sun at the site', () => {
    expect(retrainFrameLighting({ capturedAt: NOON, chromaSpread: 40, coordinates: SITE })).toEqual(
      { condition: 'day', night: false, source: 'sun' },
    )
    expect(
      retrainFrameLighting({ capturedAt: NIGHT, chromaSpread: 40, coordinates: SITE }),
    ).toEqual({ condition: 'night', night: true, source: 'sun' })
  })

  it('without coordinates it says the answer is the clock', () => {
    expect(retrainFrameLighting({ capturedAt: NOON, coordinates: null })).toEqual({
      condition: 'day',
      night: false,
      source: 'clock',
    })
  })

  it('is unknown — never guessed from the selection time — when nothing dates or measures the frame', () => {
    expect(retrainFrameLighting({ coordinates: SITE })).toBeNull()
  })
})
