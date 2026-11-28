import type { EncodeProfile } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import {
  NO_SECTIONS,
  PASSTHROUGH_PROFILE,
  type SectionState,
  changedFieldCount,
  isPassthrough,
  profileToSave,
  sectionsOf,
  withAudioCodec,
  withFps,
  withWidth,
  withVideoCodec,
} from '../encode-sections.js'

const on = (patch: Partial<SectionState>): SectionState => ({ ...NO_SECTIONS, ...patch })

describe('sectionsOf: a stored profile switches on exactly the sections its fields imply', () => {
  const cases: ReadonlyArray<readonly [string, EncodeProfile | undefined, SectionState]> = [
    ['nothing stored', undefined, NO_SECTIONS],
    ['passthrough', PASSTHROUGH_PROFILE, NO_SECTIONS],
    [
      'resize + h264 + aac',
      { video: { codec: 'h264', width: 854 }, audio: { codec: 'aac' } },
      on({ resize: true, codec: true, audio: true }),
    ],
    [
      'resize only',
      { video: { codec: 'source', width: 854 }, audio: 'passthrough' },
      on({ resize: true }),
    ],
    [
      'a height stored by the old editor still switches Resize on',
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
      'a source codec is the codec section OFF',
      { video: { codec: 'source' }, audio: 'passthrough' },
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
    const p = withAudioCodec(withVideoCodec(withWidth(undefined, 854), 'h264'), 'aac')
    expect(p).toEqual({ video: { codec: 'h264', width: 854 }, audio: { codec: 'aac' } })
    expect(sectionsOf(p)).toEqual(on({ resize: true, codec: true, audio: true }))
  })

  it('resize only re-encodes in the source codec', () => {
    expect(withWidth(undefined, 854)).toEqual({
      video: { codec: 'source', width: 854 },
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
      video: { codec: 'h264', width: 854, fps: 10, bitrateKbps: 800 },
      audio: { codec: 'aac', bitrateKbps: 64 },
      outputArgs: ['-copyts'],
    }
    expect(withWidth(full, undefined).video).toEqual({ codec: 'h264', fps: 10, bitrateKbps: 800 })
    expect(withFps(full, undefined).video.width).toBe(854)
    expect(withAudioCodec(full, null).audio).toBe('passthrough')
    expect(withAudioCodec(full, null).outputArgs).toEqual(['-copyts'])
    // codec off keeps the rest: still a re-encode in the source codec
    expect(withVideoCodec(full, null).video).toEqual({
      codec: 'source',
      width: 854,
      fps: 10,
      bitrateKbps: 800,
    })
  })

  it('every section off is the passthrough profile', () => {
    const p = withWidth(withVideoCodec(withAudioCodec(undefined, 'aac'), 'h264'), 854)
    const off = withAudioCodec(withVideoCodec(withWidth(p, undefined), null), null)
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

describe('resize is keyed on the width', () => {
  it('replaces a height stored by the old editor instead of keeping both', () => {
    const stored: EncodeProfile = {
      video: { codec: 'h264', height: 720, bitrateKbps: 777 },
      audio: 'passthrough',
    }
    expect(withWidth(stored, 1280).video).toEqual({
      codec: 'h264',
      width: 1280,
      bitrateKbps: 777,
    })
  })
  it('clearing the width clears a leftover height too', () => {
    const stored: EncodeProfile = { video: { codec: 'source', height: 720 }, audio: 'passthrough' }
    expect(withWidth(stored, undefined).video).toEqual({ codec: 'copy' })
  })
})

describe('changedFieldCount', () => {
  it('is 0 for the same profile and for none against passthrough', () => {
    expect(changedFieldCount(PASSTHROUGH_PROFILE, PASSTHROUGH_PROFILE)).toBe(0)
    expect(changedFieldCount(undefined, PASSTHROUGH_PROFILE)).toBe(0)
  })
  it('counts each changed video field, the audio and the args once', () => {
    const edited = withWidth(withAudioCodec(undefined, 'aac'), 854)
    // codec copy -> source, width added, audio changed
    expect(changedFieldCount(undefined, edited)).toBe(3)
    expect(changedFieldCount(undefined, { ...PASSTHROUGH_PROFILE, outputArgs: ['-a'] })).toBe(1)
  })
})

describe('profileToSave: passthrough is no profile', () => {
  it('passthrough saves undefined, stored or not', () => {
    expect(profileToSave(PASSTHROUGH_PROFILE)).toBeUndefined()
  })
  it('a profile with anything on is saved as is', () => {
    const p = withWidth(undefined, 640)
    expect(profileToSave(p)).toEqual(p)
  })
  it('raw args keep a profile from being passthrough', () => {
    const p: EncodeProfile = { ...PASSTHROUGH_PROFILE, outputArgs: ['-copyts'] }
    expect(profileToSave(p)).toEqual(p)
  })
})

describe('fields with no section and no Expert input survive every edit', () => {
  const extras: ReadonlyArray<readonly [string, EncodeProfile['video']]> = [
    ['profile', { codec: 'h264', profile: 'baseline' }],
    ['level', { codec: 'h264', level: '3.1' }],
    ['preset', { codec: 'h264', preset: 'veryfast' }],
    ['tune', { codec: 'h264', tune: 'zerolatency' }],
    ['bf', { codec: 'h264', bf: 0 }],
    [
      'all of them',
      { codec: 'h265', profile: 'main', level: '4.0', preset: 'fast', tune: 'film', bf: 2 },
    ],
    ['tuning on a copy codec', { codec: 'copy', level: '3.1' }],
  ]
  it.each(extras)('%s: opening changes nothing, an unrelated edit keeps it', (_name, video) => {
    const stored: EncodeProfile = { video, audio: 'passthrough' }
    const { codec: _codec, ...tuning } = video
    const keep = (p: EncodeProfile) => expect(p.video).toMatchObject(tuning)
    // resize on, then off again, then fps, then an audio change, then width/bitrate
    keep(withWidth(stored, 854))
    keep(withWidth(withWidth(stored, 854), undefined))
    keep(withFps(stored, 15))
    keep(withAudioCodec(stored, 'aac'))
    keep(withVideoCodec(stored, 'h264'))
    keep(withVideoCodec(stored, null))
    expect(sectionsOf(stored).resize).toBe(false)
    expect(profileToSave(stored)).toEqual(stored)
  })
})
