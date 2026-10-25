import { describe, expect, it } from 'vitest'
import type { RecordingConfig } from '@camstack/types'
import { bandAudioAt } from '../band-decision.js'

/**
 * A band says whether its footage carries sound.
 *
 * The recorder has always attached with `audio: 'aac'`, so every band of every
 * camera recorded sound whether or not anyone wanted it there. The broker
 * already serves the other answer — `audio: 'none'` takes the video-only
 * `/muted` restream — so this is a choice the product could always have
 * offered and never did.
 *
 * It belongs on the BAND, not on the camera: "record the shop floor silently
 * during opening hours and with sound overnight" is one camera and two
 * answers. And it applies to BOTH modes: an events band that fires on motion
 * has exactly the same question to answer as a continuous one.
 *
 * The default is what shipped. An absent `audio` is `on`, because every
 * recording written before this existed carried sound, and a band whose key
 * is missing must keep meaning what it meant.
 */

const band = (over: Partial<RecordingConfig['bands'][number]> = {}) => ({
  days: [],
  start: '00:00',
  end: '23:59',
  mode: 'continuous' as const,
  ...over,
})

const config = (bands: readonly unknown[], enabled = true): RecordingConfig =>
  ({ enabled, bands }) as unknown as RecordingConfig

const AT = new Date('2026-09-19T12:00:00Z')

describe('bandAudioAt', () => {
  it('records WITH sound when the band says nothing — the shipped behaviour', () => {
    expect(bandAudioAt(config([band()]), AT)).toBe('on')
  })

  it('records silently when the band asks for it', () => {
    expect(bandAudioAt(config([band({ audio: 'muted' })]), AT)).toBe('muted')
  })

  it('answers for an events band too, not just a continuous one', () => {
    expect(bandAudioAt(config([band({ mode: 'events', audio: 'muted' })]), AT)).toBe('muted')
  })

  it('lets two bands of one camera disagree', () => {
    // The whole point: silent by day, sound at night, one camera.
    const cfg = config([
      band({ start: '08:00', end: '20:00', audio: 'muted' }),
      band({ start: '20:00', end: '08:00', audio: 'on' }),
    ])
    expect(bandAudioAt(cfg, new Date('2026-09-19T10:00:00Z'))).toBe('muted')
    expect(bandAudioAt(cfg, new Date('2026-09-19T22:00:00Z'))).toBe('on')
  })

  it('says ON when no band covers the moment, and when recording is off', () => {
    // Not a recording decision — `shouldRecordAt` owns that. This answers only
    // "if we record now, with sound or without", and the safe answer to a
    // question nobody configured is the one that loses no evidence.
    expect(bandAudioAt(config([]), AT)).toBe('on')
    expect(bandAudioAt(config([band({ audio: 'muted' })], false), AT)).toBe('on')
  })
})
