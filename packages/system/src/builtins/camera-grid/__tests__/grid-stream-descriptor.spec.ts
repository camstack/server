/**
 * The ONE catalog descriptor a grid camera publishes.
 *
 * The thing this suite really exists for is `profileHint`. A device with a
 * single stream and NO hint is ranked by pixel count into `mid` — the slot no
 * storage class is written for on its own and the one scrub never reads. That
 * is the Dreame robot bug, and a composite is a single-stream device again, so
 * the hint has to be stated rather than inferred.
 */
import { describe, expect, it } from 'vitest'
import { GRID_CAM_STREAM_ID } from '../grid-profiles.js'
import { gridStreamDescriptor } from '../grid-stream-descriptor.js'

const BASE = {
  profile: 'high',
  width: 1920,
  height: 1080,
  fps: 10,
  url: 'http://127.0.0.1:41234/grid/inst-1/high.flv',
} as const

describe('gridStreamDescriptor', () => {
  it('states the slot it IS, so the pixel-count heuristic never decides for it', () => {
    expect(gridStreamDescriptor(BASE).profileHint).toBe('high')
    expect(gridStreamDescriptor({ ...BASE, profile: 'low' }).profileHint).toBe('low')
  })

  it('gives each profile its OWN id — two compositions under one id is one', () => {
    const ids = (['high', 'mid', 'low'] as const).map(
      (profile) => gridStreamDescriptor({ ...BASE, profile }).camStreamId,
    )
    expect(new Set(ids).size).toBe(3)
  })

  it('is a pull-flv h264 stream at the session endpoint, at the canvas size', () => {
    expect(gridStreamDescriptor(BASE)).toEqual({
      camStreamId: GRID_CAM_STREAM_ID,
      kind: 'pull-flv',
      url: BASE.url,
      codec: 'h264',
      resolution: { width: 1920, height: 1080 },
      fps: 10,
      label: 'Grid composition (high)',
      profileHint: 'high',
      autoEligible: true,
    })
  })

  it('keeps ONE camStreamId per profile whatever the canvas — a re-publish mints nothing', () => {
    expect(gridStreamDescriptor(BASE).camStreamId).toBe(
      gridStreamDescriptor({ ...BASE, fps: 25, width: 1280, height: 720 }).camStreamId,
    )
  })
})
