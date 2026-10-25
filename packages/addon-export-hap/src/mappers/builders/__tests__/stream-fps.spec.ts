/**
 * R2 — what we advertise to HomeKit must reflect the stream we actually send.
 *
 * Before this module the delegate advertised EVERY resolution at 30 fps, a
 * number that appears nowhere in the broker: it was invented. On device 101
 * the Mid 1280×720 slot really runs at ~10 fps, and because the picker steers
 * a 1280×720 request onto Mid by construction, a controller that asked for
 * "720p at 30" was handed a 10 fps feed. These tests pin the derivation, not
 * the number — they drive the REAL `pickPreferredRtspEntry` so the slot each
 * advertised resolution resolves to is the slot production will dial.
 */
import { describe, expect, it } from 'vitest'

import type {
  CameraStream,
  ProfileRtspEntry,
  ProfileSlot,
  WebrtcStreamChoice,
} from '@camstack/types'

import {
  ASSUMED_FPS,
  deriveAdvertisedResolutions,
  resolveProfileFps,
  toHapResolutions,
  type AdvertisedResolution,
} from '../stream-fps.js'

const DEVICE_ID = 101

function choice(profile: 'high' | 'mid' | 'low', inputFps: number | null): WebrtcStreamChoice {
  return {
    id: `profile:${profile}`,
    label: profile,
    target: { kind: 'profile', profile },
    codec: 'h264',
    resolution: null,
    status: 'streaming',
    inputFps,
    bitrateKbps: null,
  }
}

function adaptiveChoice(): WebrtcStreamChoice {
  return {
    id: 'adaptive',
    label: 'Adaptive',
    target: { kind: 'adaptive' },
    codec: null,
    resolution: null,
    status: null,
    inputFps: null,
    bitrateKbps: null,
  }
}

function slot(profile: 'high' | 'mid' | 'low', sourceCamStreamId: string | null): ProfileSlot {
  return {
    deviceId: DEVICE_ID,
    profile,
    brokerId: `${DEVICE_ID}/${profile}`,
    sourceCamStreamId,
    status: 'streaming',
  }
}

function camStream(camStreamId: string, fps?: number): CameraStream {
  return {
    camStreamId,
    deviceId: DEVICE_ID,
    kind: 'pull-rtsp',
    ...(fps === undefined ? {} : { fps }),
  }
}

function entry(
  profile: 'high' | 'mid' | 'low',
  width: number,
  height: number,
  enabled = true,
): ProfileRtspEntry {
  return {
    profile,
    brokerId: `${DEVICE_ID}/${profile}`,
    url: `rtsp://hub/${DEVICE_ID}/${profile}`,
    mutedUrl: `rtsp://hub/${DEVICE_ID}/${profile}?muted=1`,
    enabled,
    codec: 'h264',
    resolution: { width, height },
  }
}

/** The 101 shape from the live hub: High 4K@25, Mid 720p@10, Low 360p@25. */
const ENTRIES_101: readonly ProfileRtspEntry[] = [
  entry('high', 3840, 2160),
  entry('mid', 1280, 720),
  entry('low', 640, 360),
]

describe('resolveProfileFps', () => {
  it('prefers the MEASURED broker rate over the published one', () => {
    const resolved = resolveProfileFps({
      choices: [adaptiveChoice(), choice('high', 25), choice('mid', 10.11), choice('low', 25.26)],
      slots: [slot('mid', 'native:sub')],
      camStreams: [camStream('native:sub', 25)],
    })

    expect(resolved.get('mid')).toEqual({ profile: 'mid', fps: 10, source: 'measured' })
    expect(resolved.get('high')).toEqual({ profile: 'high', fps: 25, source: 'measured' })
    expect(resolved.get('low')).toEqual({ profile: 'low', fps: 25, source: 'measured' })
  })

  it('falls back to the PUBLISHED cam-stream rate when the broker is idle (fps 0)', () => {
    // A cold broker reports inputFps 0 — that is "not measured", not "0 fps".
    const resolved = resolveProfileFps({
      choices: [choice('mid', 0)],
      slots: [slot('mid', 'native:sub')],
      camStreams: [camStream('native:sub', 12)],
    })

    expect(resolved.get('mid')).toEqual({ profile: 'mid', fps: 12, source: 'published' })
  })

  it('falls back to ASSUMED when neither a measurement nor a published rate exists', () => {
    const resolved = resolveProfileFps({
      choices: [choice('mid', null)],
      slots: [slot('mid', 'native:sub')],
      camStreams: [camStream('native:sub')],
    })

    expect(resolved.get('mid')).toEqual({ profile: 'mid', fps: ASSUMED_FPS, source: 'assumed' })
  })

  it('ignores the adaptive choice — it has no fixed source rate', () => {
    const resolved = resolveProfileFps({ choices: [adaptiveChoice()], slots: [], camStreams: [] })
    expect(resolved.size).toBe(0)
  })

  it('clamps a measurement to the HAP-representable 1..30 integer range', () => {
    const resolved = resolveProfileFps({
      choices: [choice('high', 59.94), choice('low', 0.4)],
      slots: [],
      camStreams: [],
    })

    expect(resolved.get('high')?.fps).toBe(30)
    // Sub-1 fps is not representable; it degrades to the assumed rate rather
    // than advertising 0 (which HAP rejects) or rounding up to a lie.
    expect(resolved.get('low')).toEqual({ profile: 'low', fps: ASSUMED_FPS, source: 'assumed' })
  })
})

describe('deriveAdvertisedResolutions', () => {
  it('advertises 720p at the rate MID really runs, not 30', () => {
    const advertised = deriveAdvertisedResolutions({
      candidates: [
        [1920, 1080],
        [1280, 720],
        [640, 360],
      ],
      entries: ENTRIES_101,
      deviceId: DEVICE_ID,
      pref: 'auto',
      fpsByProfile: resolveProfileFps({
        choices: [choice('high', 25), choice('mid', 10.11), choice('low', 25.26)],
        slots: [],
        camStreams: [],
      }),
    })

    const at720 = advertised.find((a) => a.width === 1280 && a.height === 720)
    expect(at720).toEqual<AdvertisedResolution>({
      width: 1280,
      height: 720,
      fps: 10,
      profile: 'mid',
      source: 'measured',
    })
    // And nothing in the list still claims the invented 30.
    expect(advertised.every((a) => a.fps !== 30)).toBe(true)
  })

  it('resolves each candidate through the picker the START path uses', () => {
    const advertised = deriveAdvertisedResolutions({
      candidates: [
        [1920, 1080],
        [640, 360],
      ],
      entries: ENTRIES_101,
      deviceId: DEVICE_ID,
      pref: 'auto',
      fpsByProfile: resolveProfileFps({
        choices: [choice('high', 25), choice('mid', 10), choice('low', 24)],
        slots: [],
        camStreams: [],
      }),
    })

    // 1080p has no ≥-target slot below 4K, so the picker takes High (3840×2160).
    expect(advertised.find((a) => a.height === 1080)?.profile).toBe('high')
    expect(advertised.find((a) => a.height === 1080)?.fps).toBe(25)
    // 360p matches Low exactly.
    expect(advertised.find((a) => a.height === 360)?.profile).toBe('low')
    expect(advertised.find((a) => a.height === 360)?.fps).toBe(24)
  })

  it('honours a PINNED preference — every advertised rate is that slot rate', () => {
    const advertised = deriveAdvertisedResolutions({
      candidates: [
        [1920, 1080],
        [1280, 720],
        [640, 360],
      ],
      entries: ENTRIES_101,
      deviceId: DEVICE_ID,
      pref: 'mid',
      fpsByProfile: resolveProfileFps({
        choices: [choice('high', 25), choice('mid', 10), choice('low', 25)],
        slots: [],
        camStreams: [],
      }),
    })

    expect(advertised.map((a) => a.profile)).toEqual(['mid', 'mid', 'mid'])
    expect(advertised.map((a) => a.fps)).toEqual([10, 10, 10])
  })

  it('falls back to the assumed rate when the device has no publishable entry', () => {
    const advertised = deriveAdvertisedResolutions({
      candidates: [[1280, 720]],
      entries: [entry('mid', 1280, 720, false)],
      deviceId: DEVICE_ID,
      pref: 'auto',
      fpsByProfile: new Map(),
    })

    expect(advertised).toEqual<AdvertisedResolution[]>([
      { width: 1280, height: 720, fps: ASSUMED_FPS, profile: null, source: 'assumed' },
    ])
  })

  it('never emits an empty list — HAP rejects a camera with no resolutions', () => {
    const advertised = deriveAdvertisedResolutions({
      candidates: [],
      entries: ENTRIES_101,
      deviceId: DEVICE_ID,
      pref: 'auto',
      fpsByProfile: new Map(),
    })

    expect(advertised.length).toBeGreaterThan(0)
  })
})

describe('toHapResolutions', () => {
  it('projects onto the [width, height, fps] triples hap-nodejs expects', () => {
    expect(
      toHapResolutions([
        { width: 1280, height: 720, fps: 10, profile: 'mid', source: 'measured' },
        { width: 640, height: 360, fps: 25, profile: 'low', source: 'measured' },
      ]),
    ).toEqual([
      [1280, 720, 10],
      [640, 360, 25],
    ])
  })
})
