/**
 * Synthetic markers — media retried until it LANDS, under a bound (D60).
 *
 * Camera 587's snapshot endpoint answered HTTP 503 at the instant of a lock /
 * contact press: the marker landed with `snapshots: []`, final, never retried.
 * Covers:
 *  - a null / failed read lands the marker bare (the notification never waits),
 *    then the media is ATTACHED to the SAME marker (upsert, no duplicate)
 *  - the bound: first read + N retries, then a named give-up
 *  - a frame fetched later than the stale bound after the event is refused
 *  - a marker that already has media is never retried
 */
import type { Track } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import {
  type SnapshotClient,
  SyntheticTrackMaterializer,
  type SyntheticTrackMediaSink,
  type SyntheticTrackSink,
} from '../services/synthetic-track.js'

const okAnswer = { base64: Buffer.from('jpeg').toString('base64'), contentType: 'image/jpeg' }

const press = (timestamp: number) => ({
  cameraId: 587,
  sourceDeviceId: 10,
  source: 'sensor' as const,
  kind: 'contact',
  timestamp,
})

function makeMedia(): { puts: string[]; sink: SyntheticTrackMediaSink } {
  const puts: string[] = []
  return {
    puts,
    sink: {
      put: async (p) => {
        puts.push(p.ownerId)
        return 4242
      },
    },
  }
}

function makeTracks(): { rows: Track[]; sink: SyntheticTrackSink } {
  const rows: Track[] = []
  return { rows, sink: { persistSyntheticTrack: async (t) => void rows.push(t) } }
}

/** A snapshot cap answering `answers[i]` on call i (the last repeats); an Error rejects. */
function scripted(answers: ReadonlyArray<typeof okAnswer | null | Error>): {
  client: SnapshotClient
  calls: () => number
} {
  let i = 0
  return {
    calls: () => i,
    client: {
      getSnapshot: async () => {
        const a = answers[Math.min(i++, answers.length - 1)]
        if (a instanceof Error) throw a
        return a ?? null
      },
    },
  }
}

describe('SyntheticTrackMaterializer — media retried until it lands (D60)', () => {
  it('a null snapshot lands the marker bare, then ATTACHES the media to the SAME marker', async () => {
    const media = makeMedia()
    const tracks = makeTracks()
    const outcomes: Array<{ outcome: string; attempt: number; deviceId: number }> = []
    const m = new SyntheticTrackMaterializer({
      snapshot: scripted([null, null, okAnswer]).client,
      media: media.sink,
      tracks: tracks.sink,
      makeId: () => 'synth-r',
      now: () => 1_000,
      retryDelaysMs: [0, 0, 0],
      onMediaOutcome: (o) => outcomes.push(o),
    })

    const track = await m.materialize(press(1_000))
    expect(track?.snapshots).toHaveLength(0)
    expect(tracks.rows).toHaveLength(1)

    await m.whenMediaSettled()

    // Same marker id written twice (upsert): bare first, then with media.
    expect(tracks.rows.map((r) => r.trackId)).toEqual(['synth-r', 'synth-r'])
    expect(tracks.rows[1]?.snapshots).toHaveLength(1)
    expect(tracks.rows[1]?.snapshots[0]?.mediaId).toBe(4242)
    expect(media.puts).toEqual(['synth-r'])
    expect(outcomes).toEqual([{ outcome: 'landed', attempt: 2, deviceId: 587, trackId: 'synth-r' }])
  })

  it('gives up after the bound, names why, and never writes media', async () => {
    const media = makeMedia()
    const tracks = makeTracks()
    const outcomes: Array<{ outcome: string; attempt: number; reason?: string }> = []
    const snap = scripted([new Error('HTTP 503')])
    const m = new SyntheticTrackMaterializer({
      snapshot: snap.client,
      media: media.sink,
      tracks: tracks.sink,
      now: () => 1_000,
      retryDelaysMs: [0, 0, 0],
      onMediaOutcome: (o) => outcomes.push(o),
    })
    await m.materialize(press(1_000))
    await m.whenMediaSettled()

    expect(snap.calls()).toBe(4) // the first read + 3 retries
    expect(media.puts).toHaveLength(0)
    expect(tracks.rows).toHaveLength(1)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ outcome: 'gave-up', attempt: 3 })
    expect(outcomes[0]?.reason).toContain('HTTP 503')
  })

  it('refuses a frame fetched later than the stale bound after the event', async () => {
    const media = makeMedia()
    const tracks = makeTracks()
    const outcomes: Array<{ outcome: string }> = []
    let clock = 1_000
    const m = new SyntheticTrackMaterializer({
      snapshot: { getSnapshot: async () => (clock === 1_000 ? null : okAnswer) },
      media: media.sink,
      tracks: tracks.sink,
      now: () => clock,
      retryDelaysMs: [0],
      maxAttachAgeMs: 20_000,
      onMediaOutcome: (o) => outcomes.push(o),
    })
    await m.materialize(press(1_000))
    clock = 1_000 + 20_001
    await m.whenMediaSettled()

    expect(media.puts).toHaveLength(0)
    expect(tracks.rows).toHaveLength(1)
    expect(outcomes[0]?.outcome).toBe('stale-refused')
  })

  it('a marker that landed with media is never retried', async () => {
    const snap = scripted([okAnswer])
    const m = new SyntheticTrackMaterializer({
      snapshot: snap.client,
      media: makeMedia().sink,
      tracks: makeTracks().sink,
      now: () => 1_000,
      retryDelaysMs: [0, 0, 0],
    })
    await m.materialize(press(1_000))
    await m.whenMediaSettled()
    expect(snap.calls()).toBe(1)
  })
})
