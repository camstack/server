/**
 * Synthetic tracks — the ONE projector for non-spatial events
 * (event-kinds-taxonomy §8; audio markers D62).
 *
 * Covers:
 *  - a synthetic track is created carrying an on-demand best shot in the
 *    getTrackMedia media shape (ownerKind 'track', kind 'keyFrameSmall' so the
 *    viewer hero/clean/reel selectors pick it up — 'snapshot' is ignored there)
 *  - positions:[] (spatial no-op) + the isSpatialTrack ALLOW-LIST
 *  - an audio marker gets the same shape, its own `source`, and carries its
 *    class on `audioLabels`
 *  - debounce per (camera, kind)
 *  - snapshot failure still lands a track (no media), never throws
 *  - a hanging snapshot cap is bounded by a timeout (skip media, track lands)
 */

import type { Track } from '@camstack/types'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import {
  isSpatialTrack,
  type SnapshotClient,
  SyntheticTrackMaterializer,
  type SyntheticTrackMediaSink,
  type SyntheticTrackSink,
} from '../services/synthetic-track.js'

/** Deterministic media ROW id (D482) for a fixture LABEL — not a real
 *  rowid, just a stable, non-zero number a test can assert back against for
 *  the same label. */
function mediaIdFor(label: string): number {
  let hash = 0
  for (const ch of label) hash = (hash * 31 + ch.charCodeAt(0)) % 100_000
  return hash + 1000
}

function makeMedia(): {
  puts: Array<{ ownerId: string; ownerKind: string; kind: string }>
  sink: SyntheticTrackMediaSink
} {
  const puts: Array<{ ownerId: string; ownerKind: string; kind: string }> = []
  return {
    puts,
    sink: {
      put: async (p) => {
        puts.push({ ownerId: p.ownerId, ownerKind: p.ownerKind, kind: p.kind })
        return mediaIdFor(`media-${p.ownerId}`)
      },
    },
  }
}

function makeTracks(): { rows: Track[]; sink: SyntheticTrackSink } {
  const rows: Track[] = []
  return { rows, sink: { persistSyntheticTrack: async (t) => void rows.push(t) } }
}

const okSnapshot: SnapshotClient = {
  getSnapshot: async () => ({
    base64: Buffer.from('jpeg-bytes').toString('base64'),
    contentType: 'image/jpeg',
  }),
}

describe('SyntheticTrackMaterializer', () => {
  it('creates a synthetic track carrying a snapshot in the track-media shape', async () => {
    const media = makeMedia()
    const tracks = makeTracks()
    let n = 0
    const m = new SyntheticTrackMaterializer({
      snapshot: okSnapshot,
      media: media.sink,
      tracks: tracks.sink,
      makeId: () => `synth-${n++}`,
      now: () => 1000,
    })

    const track = await m.materialize({
      cameraId: 5,
      sourceDeviceId: 10,
      source: 'sensor',
      kind: 'contact',
      timestamp: 42,
    })

    expect(track).not.toBeNull()
    expect(track?.className).toBe('contact')
    expect(track?.source).toBe('sensor')
    // The accumulated-class column, seeded with the one class this row will
    // ever have. It was left NULL, and `classes` compiles to a SUPERSET
    // prefilter that KEEPS a row whose column it cannot read — so on the live
    // hub every class selection returned every synthetic row and no class
    // selection ever selected one by its kind. `classes: ['contact']` answered
    // 116 rows, none of them a contact row matched by its class.
    expect(track?.classes).toEqual(['contact'])
    expect(track?.deviceId).toBe(5)
    expect(track?.positions).toEqual([])
    expect(track?.snapshots).toHaveLength(1)
    expect(track?.snapshots[0]?.mediaId).toBe(mediaIdFor('media-synth-0'))
    // Media written under the track owner as keyFrameSmall (getTrackMedia shape) —
    // the kind the viewer representative-image selectors (hero/clean/reel) consume.
    expect(media.puts).toEqual([{ ownerId: 'synth-0', ownerKind: 'track', kind: 'keyFrameSmall' }])
    expect(tracks.rows).toHaveLength(1)
  })

  it('is skipped by spatial consumers (source:sensor, no positions)', async () => {
    const m = new SyntheticTrackMaterializer({
      snapshot: okSnapshot,
      media: makeMedia().sink,
      tracks: makeTracks().sink,
      now: () => 1000,
    })
    const track = await m.materialize({
      cameraId: 5,
      sourceDeviceId: 10,
      source: 'sensor',
      kind: 'lock',
      timestamp: 1,
    })
    expect(track).not.toBeNull()
    expect(isSpatialTrack(track!)).toBe(false)
    // A normal pipeline track is spatial; a legacy row with no source is too.
    expect(isSpatialTrack({ source: 'pipeline' })).toBe(true)
    expect(isSpatialTrack({})).toBe(true)
    // ALLOW-LIST, not `!== 'sensor'`: every synthetic source is non-spatial,
    // including the ones added after this predicate was written.
    expect(isSpatialTrack({ source: 'audio' })).toBe(false)
  })

  it('projects an AUDIO marker with the same shape and its own source', async () => {
    const media = makeMedia()
    const tracks = makeTracks()
    const m = new SyntheticTrackMaterializer({
      snapshot: okSnapshot,
      media: media.sink,
      tracks: tracks.sink,
      makeId: () => 'synth-audio',
      now: () => 1000,
    })
    const track = await m.materialize({
      cameraId: 101,
      // The camera IS the producer of an audio event — no linked device.
      sourceDeviceId: 101,
      source: 'audio',
      kind: 'audio',
      timestamp: 42,
      audioLabels: [{ label: 'dog', peakScore: 0.82, count: 1, firstAt: 42, lastAt: 42 }],
    })
    expect(track?.source).toBe('audio')
    expect(track?.className).toBe('audio')
    // Same column, same reason — and `className` is the MACRO here (D189), so
    // the class heard still lives only on `audioLabels`.
    expect(track?.classes).toEqual(['audio'])
    expect(track?.positions).toEqual([])
    expect(isSpatialTrack(track!)).toBe(false)
    // The class labels the marker via the field that already means this —
    // no invented taxonomy sub-class, no abuse of producingDeviceName.
    expect(track?.audioLabels).toEqual([
      { label: 'dog', peakScore: 0.82, count: 1, firstAt: 42, lastAt: 42 },
    ])
    expect(track?.producingDeviceName).toBeUndefined()
    // Same media contract as a sensor marker — ONE projector, one lesson.
    expect(media.puts).toEqual([
      { ownerId: 'synth-audio', ownerKind: 'track', kind: 'keyFrameSmall' },
    ])
  })

  it('debounces per (camera, kind)', async () => {
    const tracks = makeTracks()
    let now = 1000
    const m = new SyntheticTrackMaterializer({
      snapshot: okSnapshot,
      media: makeMedia().sink,
      tracks: tracks.sink,
      debounceMs: 10_000,
      now: () => now,
    })
    expect(
      await m.materialize({
        cameraId: 5,
        sourceDeviceId: 10,
        source: 'sensor',
        kind: 'contact',
        timestamp: 1,
      }),
    ).not.toBeNull()
    // Within the window → debounced.
    now = 5000
    expect(
      await m.materialize({
        cameraId: 5,
        sourceDeviceId: 10,
        source: 'sensor',
        kind: 'contact',
        timestamp: 2,
      }),
    ).toBeNull()
    // A different kind on the same camera is independent.
    expect(
      await m.materialize({
        cameraId: 5,
        sourceDeviceId: 10,
        source: 'sensor',
        kind: 'flood',
        timestamp: 3,
      }),
    ).not.toBeNull()
    // Past the window → allowed again.
    now = 12_000
    expect(
      await m.materialize({
        cameraId: 5,
        sourceDeviceId: 10,
        source: 'sensor',
        kind: 'contact',
        timestamp: 4,
      }),
    ).not.toBeNull()
    expect(tracks.rows).toHaveLength(3)
  })

  /**
   * D189 moved the audio class OFF `kind` and onto `audioLabels` — which
   * silently collapsed this debounce from per-(camera, class) to per-camera,
   * because every audio row now says `kind: 'audio'`.
   *
   * That matters because the episode hysteresis cools down PER CLASS
   * (`audio-episode-hysteresis.ts`: `lastClosedClass === className`): a dog
   * barking three seconds after someone stops talking opens a second episode
   * immediately, and a per-camera debounce would drop it on the floor. The
   * debounce has to discriminate the same thing the row does.
   */
  it('debounces an AUDIO marker per heard class, not per camera', async () => {
    const tracks = makeTracks()
    let now = 1000
    const m = new SyntheticTrackMaterializer({
      snapshot: okSnapshot,
      media: makeMedia().sink,
      tracks: tracks.sink,
      debounceMs: 10_000,
      now: () => now,
    })
    const heard = (label: string, timestamp: number) => ({
      cameraId: 5,
      sourceDeviceId: 5,
      source: 'audio' as const,
      kind: 'audio',
      timestamp,
      audioLabels: [{ label, peakScore: 0.9, count: 1, firstAt: timestamp, lastAt: timestamp }],
    })

    expect(await m.materialize(heard('speech', 1))).not.toBeNull()
    // A DIFFERENT class on the same camera, inside the window → independent.
    now = 4000
    expect(await m.materialize(heard('dog', 2))).not.toBeNull()
    // The SAME class inside the window → still debounced.
    expect(await m.materialize(heard('speech', 3))).toBeNull()
    // Past the window → allowed again.
    now = 12_000
    expect(await m.materialize(heard('speech', 4))).not.toBeNull()
    expect(tracks.rows).toHaveLength(3)
  })

  it('downscales a raw native-resolution snapshot to the 960 best-shot envelope BEFORE persisting', async () => {
    // A real 4K JPEG so the sharp decode/resize path runs for real.
    const raw4k = await sharp({
      create: { width: 3840, height: 2160, channels: 3, background: { r: 10, g: 90, b: 180 } },
    })
      .jpeg({ quality: 90 })
      .toBuffer()

    const persisted: Buffer[] = []
    const media: SyntheticTrackMediaSink = {
      put: async (p) => {
        persisted.push(p.data)
        return mediaIdFor(`media-${p.ownerId}`)
      },
    }
    const m = new SyntheticTrackMaterializer({
      snapshot: {
        getSnapshot: async () => ({ base64: raw4k.toString('base64'), contentType: 'image/jpeg' }),
      },
      media,
      tracks: makeTracks().sink,
      now: () => 1000,
    })

    const track = await m.materialize({
      cameraId: 5,
      sourceDeviceId: 10,
      source: 'sensor',
      kind: 'contact',
      timestamp: 42,
    })
    expect(track?.snapshots).toHaveLength(1)
    expect(persisted).toHaveLength(1)
    const meta = await sharp(persisted[0]!).metadata()
    // Best shot at ≤960 long-side (native clean frame + 960 variant contract),
    // no longer the old ≤640 crop envelope.
    expect(meta.width).toBeLessThanOrEqual(960)
    expect(meta.height).toBeLessThanOrEqual(540)
    // But not the retired 640 cap either — a 4K source fills the 960 box.
    expect(meta.width).toBeGreaterThan(640)
    // The stored frame is far smaller than the raw 4K capture.
    expect(persisted[0]!.byteLength).toBeLessThan(raw4k.byteLength)
  })

  it('records the producing-device name on the track and lands a snapshot mediaId', async () => {
    const media = makeMedia()
    const tracks = makeTracks()
    const m = new SyntheticTrackMaterializer({
      snapshot: okSnapshot,
      media: media.sink,
      tracks: tracks.sink,
      makeId: () => 'synth-name',
      now: () => 1000,
    })

    const track = await m.materialize({
      cameraId: 5,
      sourceDeviceId: 10,
      source: 'sensor',
      kind: 'contact',
      timestamp: 42,
      producingDeviceName: 'Front Door Contact',
    })

    expect(track?.producingDeviceName).toBe('Front Door Contact')
    // Best shot ALWAYS present when the snapshot succeeds.
    expect(track?.snapshots).toHaveLength(1)
    expect(track?.snapshots[0]?.mediaId).toBe(mediaIdFor('media-synth-name'))
    expect(media.puts).toHaveLength(1)
    expect(tracks.rows[0]?.producingDeviceName).toBe('Front Door Contact')
  })

  it('still lands a track (no media) when the snapshot fails', async () => {
    const media = makeMedia()
    const tracks = makeTracks()
    const errors: string[] = []
    const m = new SyntheticTrackMaterializer({
      snapshot: { getSnapshot: async () => null },
      media: media.sink,
      tracks: tracks.sink,
      now: () => 1000,
      onError: (scope) => void errors.push(scope),
    })
    const track = await m.materialize({
      cameraId: 5,
      sourceDeviceId: 10,
      source: 'sensor',
      kind: 'contact',
      timestamp: 7,
    })
    expect(track).not.toBeNull()
    expect(track?.snapshots).toEqual([])
    expect(media.puts).toHaveLength(0)
    expect(tracks.rows).toHaveLength(1)
    expect(errors).toContain('getSnapshot')
  })

  it('bounds a hanging snapshot cap by a timeout, skipping media (track still lands)', async () => {
    const media = makeMedia()
    const tracks = makeTracks()
    const errors: string[] = []
    const m = new SyntheticTrackMaterializer({
      // Snapshot that never resolves — must not stall the sensor path.
      snapshot: { getSnapshot: () => new Promise(() => {}) },
      media: media.sink,
      tracks: tracks.sink,
      snapshotTimeoutMs: 20,
      now: () => 1000,
      onError: (scope) => void errors.push(scope),
    })
    const track = await m.materialize({
      cameraId: 5,
      sourceDeviceId: 10,
      source: 'sensor',
      kind: 'contact',
      timestamp: 9,
    })
    expect(track).not.toBeNull()
    expect(track?.snapshots).toEqual([])
    expect(media.puts).toHaveLength(0)
    expect(tracks.rows).toHaveLength(1)
    expect(errors).toContain('snapshotTimeout')
  })

  it('takes the PER-CALL bound over the default, and names the camera on the drop', async () => {
    // The sensor projection is awaited by the doorbell notification, so it
    // passes its own tight bound; the generous default belongs to the audio
    // marker, which nothing waits on. Without the per-call override this test
    // hangs for the default 10 s.
    const media = makeMedia()
    const tracks = makeTracks()
    const errors: Array<{ scope: string; deviceId?: number }> = []
    const m = new SyntheticTrackMaterializer({
      snapshot: { getSnapshot: () => new Promise(() => {}) },
      media: media.sink,
      tracks: tracks.sink,
      // The default the audio marker would get — deliberately far above the
      // per-call bound, so only the override can end this call quickly.
      snapshotTimeoutMs: 10_000,
      now: () => 1000,
      onError: (scope, _err, deviceId) =>
        void errors.push({ scope, ...(deviceId !== undefined ? { deviceId } : {}) }),
    })
    const startedAt = Date.now()
    const track = await m.materialize({
      cameraId: 101,
      sourceDeviceId: 101,
      source: 'sensor',
      kind: 'doorbell',
      timestamp: 9,
      snapshotTimeoutMs: 25,
    })
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    // The marker lands regardless — a track is never lost for a picture.
    expect(track).not.toBeNull()
    expect(track?.snapshots).toEqual([])
    expect(tracks.rows).toHaveLength(1)
    // And the drop is reported BY NAME and BY CAMERA: "why does 101's doorbell
    // marker have no picture" must be answerable from one grep.
    expect(errors).toEqual([{ scope: 'snapshotTimeout', deviceId: 101 }])
  })
})

/**
 * Battery-camera discipline (roadmap 4f, 2026-08-07).
 *
 * `snapshot.getSnapshot`'s `force` flag is contractually an OPERATOR signal —
 * `snapshot.cap.ts` says so in as many words: *"Triggered by the UI's refresh
 * button… On battery cams this WILL wake the camera — accept the cost only
 * when the user explicitly asks for it."*
 *
 * A synthetic track is materialised from a non-spatial EVENT, with nobody
 * asking. Passing `force` from here made every such event an unconditional
 * wake of a sleeping battery camera, straight past the snapshot addon's sleep
 * gate (`snapshot.addon.ts:425`, which is `!force && isBatteryDevice &&
 * sleeping`). The non-forced path still returns the cached frame, which for a
 * battery camera is exactly the intended answer.
 */
describe('SyntheticTrackMaterializer — never forces a capture', () => {
  it('does not pass force:true — a background event is not an operator asking', async () => {
    const media = makeMedia()
    const tracks = makeTracks()
    const seen: Array<{ deviceId: number; force?: boolean }> = []

    const m = new SyntheticTrackMaterializer({
      snapshot: {
        getSnapshot: async (input) => {
          seen.push(input)
          return { base64: Buffer.from('jpeg-bytes').toString('base64'), contentType: 'image/jpeg' }
        },
      },
      media: media.sink,
      tracks: tracks.sink,
      makeId: () => 'synth-force',
      now: () => 1000,
    })

    await m.materialize({
      cameraId: 106,
      sourceDeviceId: 106,
      source: 'sensor',
      kind: 'doorbell',
      timestamp: 1000,
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.force).not.toBe(true)
  })
})

/**
 * 2026-09-29, camera 101: one press produced TWO `DeviceStateChanged(doorbell)`
 * 7 ms apart. The first projection took the snapshot and landed a marker with
 * media; the second was debounced and got `null`, so ITS notification — the
 * one that won the rule — had no marker and shipped without a still. A
 * debounced sensor projection now SHARES the window's marker.
 */
describe('SyntheticTrackMaterializer — a debounced sensor projection shares the window marker', () => {
  const press = (timestamp: number) =>
    ({ cameraId: 101, sourceDeviceId: 101, source: 'sensor', kind: 'doorbell', timestamp }) as const

  it('two calls inside the window resolve to the SAME trackId with its media', async () => {
    const tracks = makeTracks()
    let releaseSnapshot: () => void = () => undefined
    const slowSnapshot: SnapshotClient = {
      getSnapshot: () =>
        new Promise((resolve) => {
          releaseSnapshot = () =>
            resolve({ base64: Buffer.from('jpeg').toString('base64'), contentType: 'image/jpeg' })
        }),
    }
    let n = 0
    const m = new SyntheticTrackMaterializer({
      snapshot: slowSnapshot,
      media: makeMedia().sink,
      tracks: tracks.sink,
      makeId: () => `synth-${n++}`,
      debounceMs: 10_000,
      now: () => 1_000,
    })

    const first = m.materializeOrShare(press(1))
    const second = m.materializeOrShare(press(8))
    releaseSnapshot()
    const [a, b] = await Promise.all([first, second])

    expect(a.kind).toBe('materialized')
    expect(b.kind).toBe('debounced')
    if (a.kind === 'not-materialized' || b.kind === 'not-materialized') throw new Error('no marker')
    expect(b.track.trackId).toBe(a.track.trackId)
    expect(b.track.snapshots).toHaveLength(1)
    // ONE marker, one snapshot: the window is shared, not re-materialized.
    expect(tracks.rows).toHaveLength(1)
  })

  it('a window whose marker did not land shares nothing: not-materialized, named', async () => {
    const m = new SyntheticTrackMaterializer({
      snapshot: okSnapshot,
      media: makeMedia().sink,
      tracks: {
        persistSyntheticTrack: async () => {
          throw new Error('disk full')
        },
      },
      debounceMs: 10_000,
      now: () => 1_000,
    })
    expect((await m.materializeOrShare(press(1))).kind).toBe('not-materialized')
    expect((await m.materializeOrShare(press(2))).kind).toBe('not-materialized')
  })

  it('the audio contract is unchanged: a debounced materialize still answers null', async () => {
    const m = new SyntheticTrackMaterializer({
      snapshot: okSnapshot,
      media: makeMedia().sink,
      tracks: makeTracks().sink,
      debounceMs: 10_000,
      now: () => 1_000,
    })
    expect(await m.materialize(press(1))).not.toBeNull()
    expect(await m.materialize(press(2))).toBeNull()
  })
})

describe('SyntheticTrackMaterializer — a sensor window belongs to ONE sensor (review L2)', () => {
  it('a second sensor of the same kind on the same camera gets its own marker and label', async () => {
    const tracks = makeTracks()
    let n = 0
    const m = new SyntheticTrackMaterializer({
      snapshot: okSnapshot,
      media: makeMedia().sink,
      tracks: tracks.sink,
      makeId: () => `synth-${n++}`,
      debounceMs: 10_000,
      now: () => 1_000,
    })
    const contact = (sourceDeviceId: number, producingDeviceName: string) =>
      ({
        cameraId: 101,
        sourceDeviceId,
        source: 'sensor',
        kind: 'contact',
        timestamp: 1,
        producingDeviceName,
      }) as const

    const front = await m.materializeOrShare(contact(4131, 'Front door'))
    const back = await m.materializeOrShare(contact(4132, 'Back door'))
    const frontAgain = await m.materializeOrShare(contact(4131, 'Front door'))

    if (front.kind === 'not-materialized' || back.kind === 'not-materialized')
      throw new Error('no marker')
    expect(back.kind).toBe('materialized')
    expect(back.track.trackId).not.toBe(front.track.trackId)
    expect(back.track.producingDeviceName).toBe('Back door')
    expect(frontAgain).toMatchObject({ kind: 'debounced', track: { trackId: front.track.trackId } })
    expect(tracks.rows).toHaveLength(2)
  })
})
