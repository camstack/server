/**
 * Motion-event stills — the thumbnail a recording-clip visit uses when the
 * camera recorded on motion with no object detection (events-mode pantry
 * walk, onboard VMD, no person track).
 *
 * Contract (timeline-clips-library spec): clip thumbnail = the main event's
 * `getEventMedia` `kind: 'snapshot'`. Object events already get stills from
 * the track capture path; motion rows historically owned none, so the
 * data-plane 404'd and the videoclip tile was empty.
 *
 * Covers:
 *  - a successful snapshot cap write lands ownerKind 'motion' / kind 'snapshot'
 *  - `force` is never set (background caller, never wake a battery camera)
 *  - a null / failed / hanging cap still resolves (never throws)
 *  - a hanging cap is bounded by the timeout
 *  - THE GATE: with debug media off, an edge inside a detection-covered or
 *    already-marked window never reaches `getSnapshot` at all
 */
import { describe, expect, it } from 'vitest'
import { makeLogRecorder, makeSilentLogger } from '../../__tests__/test-helpers.js'
import type { SnapshotClient } from '../synthetic-track.js'
import {
  MotionEventSnapshotCapturer,
  type MotionEventSnapshotMediaSink,
  type MotionStillPolicy,
} from '../motion-event-snapshot.js'

function makeMedia(): {
  puts: Array<{
    ownerId: string
    ownerKind: string
    kind: string
    deviceId: number
    timestamp: number
  }>
  sink: MotionEventSnapshotMediaSink
} {
  const puts: Array<{
    ownerId: string
    ownerKind: string
    kind: string
    deviceId: number
    timestamp: number
  }> = []
  return {
    puts,
    sink: {
      put: async (p) => {
        puts.push({
          ownerId: p.ownerId,
          ownerKind: p.ownerKind,
          kind: p.kind,
          deviceId: p.deviceId,
          timestamp: p.timestamp,
        })
        return p.timestamp
      },
    },
  }
}

/** Debug media on = every edge, which is the pre-gate behaviour these
 *  long-standing tests describe. */
const DEBUG_POLICY: MotionStillPolicy = {
  debugMediaEnabled: true,
  quietMs: 900_000,
  lastDetectionAtMs: undefined,
}
/** Debug media off, nothing ever detected = the fallback marker fires. */
const MARKER_POLICY: MotionStillPolicy = {
  debugMediaEnabled: false,
  quietMs: 900_000,
  lastDetectionAtMs: undefined,
}

const okSnapshot: SnapshotClient = {
  getSnapshot: async () => ({
    base64: Buffer.from('jpeg-bytes').toString('base64'),
    contentType: 'image/jpeg',
  }),
}

describe('MotionEventSnapshotCapturer', () => {
  it('persists the camera still as event-owned snapshot media', async () => {
    const media = makeMedia()
    const forced: boolean[] = []
    const capturer = new MotionEventSnapshotCapturer({
      snapshot: {
        getSnapshot: async (input) => {
          forced.push(input.force === true)
          return okSnapshot.getSnapshot(input)
        },
      },
      media: media.sink,
      logger: makeSilentLogger(),
    })

    await capturer.capture({
      deviceId: 1438,
      eventId: 'm-1',
      timestamp: 42,
      policy: DEBUG_POLICY,
    })

    expect(media.puts).toEqual([
      {
        ownerId: 'm-1',
        ownerKind: 'motion',
        kind: 'snapshot',
        deviceId: 1438,
        timestamp: 42,
      },
    ])
    expect(forced).toEqual([false])
  })

  it('does not throw when the snapshot cap returns null — the motion row already landed', async () => {
    const media = makeMedia()
    const capturer = new MotionEventSnapshotCapturer({
      snapshot: { getSnapshot: async () => null },
      media: media.sink,
      logger: makeSilentLogger(),
    })
    await expect(
      capturer.capture({ deviceId: 4, eventId: 'm-1', timestamp: 1, policy: DEBUG_POLICY }),
    ).resolves.toMatchObject({ captured: false })
    expect(media.puts).toEqual([])
  })

  it('does not throw when the snapshot cap fails', async () => {
    const media = makeMedia()
    const capturer = new MotionEventSnapshotCapturer({
      snapshot: {
        getSnapshot: async () => {
          throw new Error('snapshot down')
        },
      },
      media: media.sink,
      logger: makeSilentLogger(),
    })
    await expect(
      capturer.capture({ deviceId: 4, eventId: 'm-1', timestamp: 1, policy: DEBUG_POLICY }),
    ).resolves.toMatchObject({ captured: false })
    expect(media.puts).toEqual([])
  })

  it('skips media when the snapshot cap hangs past the timeout', async () => {
    const media = makeMedia()
    const capturer = new MotionEventSnapshotCapturer({
      snapshot: { getSnapshot: () => new Promise(() => {}) },
      media: media.sink,
      logger: makeSilentLogger(),
      snapshotTimeoutMs: 20,
    })
    await expect(
      capturer.capture({ deviceId: 4, eventId: 'm-1', timestamp: 1, policy: DEBUG_POLICY }),
    ).resolves.toMatchObject({ captured: false })
    expect(media.puts).toEqual([])
  })

  it('does not throw when media put fails', async () => {
    const capturer = new MotionEventSnapshotCapturer({
      snapshot: okSnapshot,
      media: {
        put: async () => {
          throw new Error('disk full')
        },
      },
      logger: makeSilentLogger(),
    })
    await expect(
      capturer.capture({ deviceId: 4, eventId: 'm-1', timestamp: 1, policy: DEBUG_POLICY }),
    ).resolves.toMatchObject({ captured: false })
  })

  // ── The gate ──────────────────────────────────────────────────────────
  //
  // Measured on the live hub: this edge fires every 1.010 s on every camera,
  // busy or quiet, because the provider emits a level KEEPALIVE and the
  // analyzer's per-frame sample resets the shared edge map between each pair.
  // The gate has to stop the WRITE, and it has to stop it before the camera
  // is asked for a frame — a fetch-then-discard implementation still wakes a
  // battery camera 92 400 times a day and encodes 9 GB it throws away.

  it('with debug media off, an edge on a camera the detector is covering never reaches the camera', async () => {
    const media = makeMedia()
    let fetches = 0
    const capturer = new MotionEventSnapshotCapturer({
      snapshot: {
        getSnapshot: async (input) => {
          fetches += 1
          return okSnapshot.getSnapshot(input)
        },
      },
      media: media.sink,
      logger: makeSilentLogger(),
    })

    const out = await capturer.capture({
      deviceId: 103,
      eventId: 'm-1',
      timestamp: 1_000_000,
      policy: { debugMediaEnabled: false, quietMs: 900_000, lastDetectionAtMs: 999_000 },
    })

    expect(out).toEqual({ captured: false, reason: 'detection-recent' })
    expect(fetches).toBe(0)
    expect(media.puts).toEqual([])
  })

  /**
   * DISARM TARGET: the whole gate.
   *
   * The fixture is the measured one — an hour of 1.010 s keepalive edges on a
   * camera with nothing detected. Gated → 4 stills and 4 camera fetches.
   * Ungated → 3 565. Both numbers are large and different, so a pass cannot
   * be "the loop never ran".
   */
  it('collapses an hour of keepalive edges into one still per drought window', async () => {
    const media = makeMedia()
    let fetches = 0
    const capturer = new MotionEventSnapshotCapturer({
      snapshot: {
        getSnapshot: async (input) => {
          fetches += 1
          return okSnapshot.getSnapshot(input)
        },
      },
      media: media.sink,
      logger: makeSilentLogger(),
    })

    let edges = 0
    for (let t = 0; t < 3_600_000; t += 1_010) {
      edges += 1
      await capturer.capture({
        deviceId: 103,
        eventId: `m-${t}`,
        timestamp: t,
        policy: MARKER_POLICY,
      })
    }

    expect(edges).toBe(3_565)
    expect(media.puts).toHaveLength(4)
    expect(fetches).toBe(4)
  })

  it('reports the drop on the marker line — one summary, not one line per edge', async () => {
    const media = makeMedia()
    const rec = makeLogRecorder()
    const capturer = new MotionEventSnapshotCapturer({
      snapshot: okSnapshot,
      media: media.sink,
      logger: rec.logger,
    })

    for (let t = 0; t < 1_800_000; t += 1_010) {
      await capturer.capture({
        deviceId: 103,
        eventId: `m-${t}`,
        timestamp: t,
        policy: MARKER_POLICY,
      })
    }

    const lines = rec.entries.filter((e) => e.message === 'motion marker still: detection drought')
    expect(lines).toHaveLength(2)
    expect(lines[0]?.extras?.tags).toEqual({ deviceId: 103 })
    // The first marker fires on the first edge, so nothing was suppressed
    // before it; the second carries the whole window it stood in for.
    expect(lines[0]?.extras?.meta?.['suppressedSinceLastMarker']).toBe(0)
    expect(lines[1]?.extras?.meta?.['suppressedSinceLastMarker']).toBe(891)
  })

  it('forgetDevice drops the window so a rebound camera marks immediately', async () => {
    const media = makeMedia()
    const capturer = new MotionEventSnapshotCapturer({
      snapshot: okSnapshot,
      media: media.sink,
      logger: makeSilentLogger(),
    })
    await capturer.capture({ deviceId: 7, eventId: 'a', timestamp: 0, policy: MARKER_POLICY })
    await capturer.capture({ deviceId: 7, eventId: 'b', timestamp: 1_010, policy: MARKER_POLICY })
    expect(media.puts).toHaveLength(1)

    capturer.forgetDevice(7)
    await capturer.capture({ deviceId: 7, eventId: 'c', timestamp: 2_020, policy: MARKER_POLICY })
    expect(media.puts).toHaveLength(2)
  })
})
