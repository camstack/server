/**
 * A SYNTHETIC audio track is shaped exactly like a REGULAR one (D189).
 *
 * The defect: `openAudioEpisode` materialized the episode with
 * `kind: ref.className` — the NAKED audio macro (`speech`, `animal`, `water`)
 * — so `Track.className` meant two different things depending on
 * `Track.source`. `animal` was a COCO quadruped on a pipeline row and a barking
 * dog on an audio row, and every consumer had to remember to look at `source`
 * to tell them apart. One did not: the viewer drew the neutral `Tag` glyph for
 * every audio episode until v1.0.354 patched it per-consumer.
 *
 * The sibling projector had it right all along:
 * `audio-marker-projector.ts` materializes `kind: 'audio'` (the taxonomy macro
 * that already exists, `EVENT_KIND_ICONS.audio`) and puts the macro on
 * `audioLabels` — which is precisely what a REGULAR track does when its camera
 * hears something. Two producers of the same row disagreed; this pins the one
 * that matches the rest of the model.
 *
 * The acceptance test is the operator's: *a consumer written for regular
 * tracks renders a synthetic one correctly without knowing that it is one.*
 * So these assertions are about FIELDS, never about `source`.
 */

import type { AudioDetection, AudioResult, IEventBus, Track } from '@camstack/types'
import { createEvent, EventCategory } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { TRACKS_COLLECTION } from '../store/track-store.js'
import { type Booted, bootAnalytics } from './boot-analytics.js'
import type { FakeNativeCropRequest } from './test-helpers.js'

const DEVICE_ID = 7

async function noNative(_request: FakeNativeCropRequest): Promise<null> {
  return null
}

function audioFrame(timestamp: number, className: string, score: number): AudioResult {
  const detection: AudioDetection = {
    id: `ad-${timestamp}`,
    kind: 'audio',
    macroClass: className,
    score,
    labels: [],
    startMs: 0,
    endMs: 32,
  }
  return {
    kind: 'audio-window',
    windowId: `w-${timestamp}`,
    deviceId: DEVICE_ID,
    timestamp,
    startMs: 0,
    endMs: 32,
    level: { rms: 0.4, dbfs: -12 },
    detections: [detection],
  }
}

function emitAudio(bus: IEventBus, timestamp: number, className: string, score = 0.9): void {
  bus.emit(
    createEvent(
      EventCategory.PipelineAudioInferenceResult,
      { type: 'addon', id: 'pipeline-runner' },
      { deviceId: DEVICE_ID, frame: audioFrame(timestamp, className, score), nodeId: 'hub' },
    ),
  )
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise<void>((r) => setTimeout(r, 1))
    await new Promise<void>((r) => setImmediate(r))
  }
}

/** The persisted rows, read back the way a consumer sees them. */
function audioTracks(booted: Booted): readonly Record<string, unknown>[] {
  const rows = [...(booted.settings.data.get(TRACKS_COLLECTION)?.values() ?? [])]
  return rows.filter((t) => t['source'] === 'audio')
}

let booted: Booted | null = null

afterEach(async () => {
  await booted?.addon.shutdown?.()
  booted = null
})

describe('a synthetic audio episode is shaped like a regular track', () => {
  it('carries the taxonomy macro `audio` on className — never the naked audio macro', async () => {
    booted = await bootAnalytics(DEVICE_ID, noNative, {
      deviceSettings: { audioEpisodeOpenHoldSec: 0, audioConfirmHits: 1 },
    })

    emitAudio(booted.bus.bus, 10_000, 'dog')
    await flush()

    const rows = audioTracks(booted)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.['className']).toBe('audio')
  })

  it('carries the heard macro on audioLabels — the field a regular track already uses', async () => {
    booted = await bootAnalytics(DEVICE_ID, noNative, {
      deviceSettings: { audioEpisodeOpenHoldSec: 0, audioConfirmHits: 1 },
    })

    emitAudio(booted.bus.bus, 10_000, 'dog')
    await flush()

    const labels = audioTracks(booted)[0]?.['audioLabels']
    expect(labels).toMatchObject([{ label: 'dog', peakScore: 0.9, count: 1 }])
  })

  /**
   * The collision that made this a bug and not a cosmetic gripe: the audio
   * macro vocabulary OVERLAPS the detection one. `animal`, `vehicle` and
   * `siren` are all live rule targets on this hub — a `classes: ['animal']`
   * rule exists — and a naked audio row put a barking dog in the ANIMAL lane.
   */
  it('never emits a detection macro as the class of an audio row', async () => {
    booted = await bootAnalytics(DEVICE_ID, noNative, {
      deviceSettings: { audioEpisodeOpenHoldSec: 0, audioConfirmHits: 1 },
    })

    emitAudio(booted.bus.bus, 10_000, 'animal')
    await flush()

    const rows = audioTracks(booted)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.['className']).not.toBe('animal')
    expect(rows[0]?.['className']).toBe('audio')
    // …and the information is not lost, it moved to where it belongs.
    expect(rows[0]?.['audioLabels']).toMatchObject([{ label: 'animal' }])
  })

  /**
   * The class must survive the episode's lastSeen re-persists — a row that
   * opens correct and is rewritten wrong is the same bug with a delay.
   */
  it('keeps the class across the episode lastSeen re-persist', async () => {
    booted = await bootAnalytics(DEVICE_ID, noNative, {
      deviceSettings: { audioEpisodeOpenHoldSec: 0, audioConfirmHits: 1 },
    })

    for (const t of [10_000, 15_000, 20_000, 25_000]) {
      emitAudio(booted.bus.bus, t, 'speech')
      await flush()
    }

    const rows = audioTracks(booted)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.['className']).toBe('audio')
    expect(rows[0]?.['audioLabels']).toMatchObject([{ label: 'speech' }])
  })
})

describe('reading a legacy row', () => {
  /**
   * 576 rows on the live hub predate the contract and carry a naked macro.
   * EVERY one of them already carries the same macro on `audioLabels` (the
   * `addAudioLabelEpisode` stamp has always run), so nothing has to be
   * recovered from the class — the class is simply rewritten to the taxonomy
   * macro on read, in ONE place, so the disk converges to one format without a
   * dual-read living forever (D182/D185).
   */
  it('normalizes a naked-macro audio row to the taxonomy macro', async () => {
    const { normalizeAudioTrackClass } = await import('../store/audio-track-class.js')
    const legacy: Track = {
      trackId: 'legacy-1',
      deviceId: DEVICE_ID,
      className: 'speech',
      source: 'audio',
      firstSeen: 1,
      lastSeen: 2,
      positions: [],
      snapshots: [],
      zonesVisited: [],
      totalDistance: 0,
      state: 'idle',
      active: false,
      audioLabels: [{ label: 'speech', peakScore: 0.9, count: 1, firstAt: 1, lastAt: 2 }],
    }
    expect(normalizeAudioTrackClass(legacy).className).toBe('audio')
  })

  it('recovers audioLabels when a legacy row somehow carries none', async () => {
    const { normalizeAudioTrackClass } = await import('../store/audio-track-class.js')
    const legacy: Track = {
      trackId: 'legacy-2',
      deviceId: DEVICE_ID,
      className: 'glass_breaking',
      source: 'audio',
      firstSeen: 1,
      lastSeen: 2,
      positions: [],
      snapshots: [],
      zonesVisited: [],
      totalDistance: 0,
      state: 'idle',
      active: false,
    }
    const out = normalizeAudioTrackClass(legacy)
    expect(out.className).toBe('audio')
    expect(out.audioLabels).toMatchObject([{ label: 'glass_breaking' }])
  })

  it('leaves a row that already speaks the contract untouched (idempotent)', async () => {
    const { normalizeAudioTrackClass } = await import('../store/audio-track-class.js')
    const modern: Track = {
      trackId: 'modern-1',
      deviceId: DEVICE_ID,
      className: 'audio',
      source: 'audio',
      firstSeen: 1,
      lastSeen: 2,
      positions: [],
      snapshots: [],
      zonesVisited: [],
      totalDistance: 0,
      state: 'idle',
      active: false,
      audioLabels: [{ label: 'dog', peakScore: 0.5, count: 2, firstAt: 1, lastAt: 2 }],
    }
    expect(normalizeAudioTrackClass(modern)).toBe(modern)
  })

  it('never touches a non-audio row', async () => {
    const { normalizeAudioTrackClass } = await import('../store/audio-track-class.js')
    const pipeline: Track = {
      trackId: 'pipe-1',
      deviceId: DEVICE_ID,
      className: 'animal',
      source: 'pipeline',
      firstSeen: 1,
      lastSeen: 2,
      positions: [],
      snapshots: [],
      zonesVisited: [],
      totalDistance: 0,
      state: 'idle',
      active: false,
    }
    expect(normalizeAudioTrackClass(pipeline)).toBe(pipeline)
  })
})
