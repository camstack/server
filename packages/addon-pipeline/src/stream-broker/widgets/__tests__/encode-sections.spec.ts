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
  withCodecSection,
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

describe('a stored source codec', () => {
  it('opens with the Video codec section ON, because it is a real re-encode', () => {
    expect(sectionsOf({ video: { codec: 'source' }, audio: 'passthrough' })).toEqual(
      on({ codec: true }),
    )
  })
  it('stays a re-encode when Keep source is the only thing on', () => {
    const p = withCodecSection(withVideoCodec(undefined, 'source'), true)
    expect(p.video.codec).toBe('source')
  })
  it('is copy again once the codec section is off and nothing else asks for a re-encode', () => {
    expect(
      withCodecSection(
        withVideoCodec({ video: { codec: 'source' }, audio: 'passthrough' }, null),
        false,
      ).video.codec,
    ).toBe('copy')
  })
  it('keeps source when a resize is removed while the codec section is on', () => {
    const resized: EncodeProfile = { video: { codec: 'source', height: 480 }, audio: 'passthrough' }
    expect(withCodecSection(withHeight(resized, undefined), true).video).toEqual({
      codec: 'source',
    })
  })
})

describe('profileToSave: passthrough is no profile', () => {
  it('passthrough saves undefined, stored or not', () => {
    expect(profileToSave(PASSTHROUGH_PROFILE)).toBeUndefined()
  })
  it('a profile with anything on is saved as is', () => {
    const p = withHeight(undefined, 360)
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
    keep(withHeight(stored, 480))
    keep(withHeight(withHeight(stored, 480), undefined))
    keep(withFps(stored, 15))
    keep(withAudioCodec(stored, 'aac'))
    keep(withVideoCodec(stored, 'h264'))
    keep(withVideoCodec(stored, null))
    expect(sectionsOf(stored).resize).toBe(false)
    expect(profileToSave(stored)).toEqual(stored)
  })
})
