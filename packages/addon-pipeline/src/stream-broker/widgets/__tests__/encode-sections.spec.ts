import type { EncodeProfile } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  NO_SECTIONS,
  PASSTHROUGH_PROFILE,
  type SectionState,
  isPassthrough,
  profileToSave,
  sectionsOf,
  withAudioCodec,
  withFps,
  withHeight,
  withVideoCodec,
} from '../encode-sections.js'

const on = (patch: Partial<SectionState>): SectionState => ({ ...NO_SECTIONS, ...patch })

describe('sectionsOf: a stored profile switches on exactly the sections its fields imply', () => {
  const cases: ReadonlyArray<readonly [string, EncodeProfile | undefined, SectionState]> = [
    ['nothing stored', undefined, NO_SECTIONS],
    ['passthrough', PASSTHROUGH_PROFILE, NO_SECTIONS],
    [
      'resize + h264 + aac',
      { video: { codec: 'h264', height: 480 }, audio: { codec: 'aac' } },
      on({ resize: true, codec: true, audio: true }),
    ],
    [
      'resize only',
      { video: { codec: 'source', height: 480 }, audio: 'passthrough' },
      on({ resize: true }),
    ],
    ['codec only', { video: { codec: 'h265' }, audio: 'passthrough' }, on({ codec: true })],
    ['audio none', { video: { codec: 'copy' }, audio: { codec: 'none' } }, on({ audio: true })],
    ['fps', { video: { codec: 'source', fps: 10 }, audio: 'passthrough' }, on({ fps: true })],
    [
      'expert only',
      {
        video: { codec: 'copy', bitrateKbps: 500, gopFrames: 30 },
        audio: 'passthrough',
        outputArgs: ['-copyts'],
      },
      NO_SECTIONS,
    ],
    [
      'width alone is Expert, not Resize',
      { video: { codec: 'source', width: 1280 }, audio: 'passthrough' },
      NO_SECTIONS,
    ],
    [
      'an audio copy object is passthrough',
      { video: { codec: 'copy' }, audio: { codec: 'copy' } },
      NO_SECTIONS,
    ],
  ]
  it.each(cases)('%s', (_name, profile, expected) => {
    expect(sectionsOf(profile)).toEqual(expected)
  })
})

describe('section edits combine, and each owns only its fields', () => {
  it('resize + h264 + aac from nothing', () => {
    const p = withAudioCodec(withVideoCodec(withHeight(undefined, 480), 'h264'), 'aac')
    expect(p).toEqual({ video: { codec: 'h264', height: 480 }, audio: { codec: 'aac' } })
    expect(sectionsOf(p)).toEqual(on({ resize: true, codec: true, audio: true }))
  })

  it('resize only re-encodes in the source codec', () => {
    expect(withHeight(undefined, 480)).toEqual({
      video: { codec: 'source', height: 480 },
      audio: 'passthrough',
    })
  })

  it('codec only', () => {
    expect(withVideoCodec(undefined, 'h265')).toEqual({
      video: { codec: 'h265' },
      audio: 'passthrough',
    })
  })

  it('audio none', () => {
    expect(withAudioCodec(undefined, 'none')).toEqual({
      video: { codec: 'copy' },
      audio: { codec: 'none' },
    })
  })

  it('fps', () => {
    expect(withFps(undefined, 10)).toEqual({
      video: { codec: 'source', fps: 10 },
      audio: 'passthrough',
    })
  })

  it('switching a section off removes only its field', () => {
    const full: EncodeProfile = {
      video: { codec: 'h264', height: 480, fps: 10, bitrateKbps: 800 },
      audio: { codec: 'aac', bitrateKbps: 64 },
      outputArgs: ['-copyts'],
    }
    expect(withHeight(full, undefined).video).toEqual({ codec: 'h264', fps: 10, bitrateKbps: 800 })
    expect(withFps(full, undefined).video.height).toBe(480)
    expect(withAudioCodec(full, null).audio).toBe('passthrough')
    expect(withAudioCodec(full, null).outputArgs).toEqual(['-copyts'])
    // codec off keeps the rest: still a re-encode in the source codec
    expect(withVideoCodec(full, null).video).toEqual({
      codec: 'source',
      height: 480,
      fps: 10,
      bitrateKbps: 800,
    })
  })

  it('every section off is the passthrough profile', () => {
    const p = withHeight(withVideoCodec(withAudioCodec(undefined, 'aac'), 'h264'), 480)
    const off = withAudioCodec(withVideoCodec(withHeight(p, undefined), null), null)
    expect(off).toEqual(PASSTHROUGH_PROFILE)
    expect(isPassthrough(off)).toBe(true)
  })

  it('an audio codec change keeps the Expert audio fields', () => {
    const p: EncodeProfile = {
      video: { codec: 'copy' },
      audio: { codec: 'aac', bitrateKbps: 96, channels: 2 },
    }
    expect(withAudioCodec(p, 'opus').audio).toEqual({ codec: 'opus', bitrateKbps: 96, channels: 2 })
  })
})

describe('profileToSave', () => {
  it('a never-stored stream back at passthrough saves undefined', () => {
    expect(profileToSave(PASSTHROUGH_PROFILE, true)).toBeUndefined()
  })
  it('a stored stream saves the explicit passthrough profile', () => {
    expect(profileToSave(PASSTHROUGH_PROFILE, false)).toEqual(PASSTHROUGH_PROFILE)
  })
  it('a profile with anything on is saved as is', () => {
    const p = withHeight(undefined, 360)
    expect(profileToSave(p, true)).toEqual(p)
  })
  it('raw args keep a profile from being passthrough', () => {
    const p: EncodeProfile = { ...PASSTHROUGH_PROFILE, outputArgs: ['-copyts'] }
    expect(profileToSave(p, true)).toEqual(p)
  })
})
