/**
 * `audioEpisodeEnabled: false` must switch OFF the GROUPING, not the audio.
 *
 * The defect (D62 shape): after the hysteresis landed, `driveAudioEpisode`
 * became the only writer on the classification branch of `handleAudioResult`,
 * and `observeAudioEpisode` answers `{ kind: 'none' }` the instant the knob is
 * off. So an operator who turned off "Create audio episodes" — a knob whose
 * form text promises that "classified audio still notifies from other paths" —
 * silently stopped getting ANY classified audio: no `AudioEvent` row, no
 * Notification Center hook, no `audioLabels`. Only the class-less level path
 * survived.
 *
 * This boots the REAL addon and asserts on the row that reached the store,
 * because that is exactly the level the defect lived at: the pure hysteresis
 * spec is green either way — `{ kind: 'none' }` when disabled is what it is
 * SUPPOSED to answer. Only the wiring around it was wrong.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { AudioDetection, AudioResult, IEventBus } from '@camstack/types'
import { EventCategory, createEvent } from '@camstack/types'
import { AUDIO_EVENTS_COLLECTION } from '../store/event-store.js'
import { TRACKS_COLLECTION } from '../store/track-store.js'
import { bootAnalytics, bootedEventRows, type Booted } from './boot-analytics.js'
import type { FakeNativeCropRequest } from './test-helpers.js'

const DEVICE_ID = 7

async function noNative(_request: FakeNativeCropRequest): Promise<null> {
  return null
}

function classified(timestamp: number, className: string, score: number): AudioDetection {
  return {
    id: `ad-${timestamp}`,
    kind: 'audio',
    macroClass: className,
    score,
    labels: [],
    startMs: 0,
    endMs: 32,
  }
}

function audioFrame(timestamp: number, className: string, score: number): AudioResult {
  return {
    kind: 'audio-window',
    windowId: `w-${timestamp}`,
    deviceId: DEVICE_ID,
    timestamp,
    startMs: 0,
    endMs: 32,
    level: { rms: 0.4, dbfs: -12 },
    detections: [classified(timestamp, className, score)],
  }
}

function emitAudio(bus: IEventBus, timestamp: number, className = 'dog', score = 0.9): void {
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

let booted: Booted | null = null

afterEach(async () => {
  await booted?.addon.shutdown?.()
  booted = null
})

describe('audioEpisodeEnabled: false', () => {
  it('still PERSISTS the classified AudioEvent, with its classification', async () => {
    booted = await bootAnalytics(DEVICE_ID, noNative, {
      deviceSettings: { audioEpisodeEnabled: false, audioConfirmHits: 1 },
    })

    emitAudio(booted.bus.bus, 10_000)
    await flush()

    const rows = bootedEventRows(booted, AUDIO_EVENTS_COLLECTION)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      deviceId: DEVICE_ID,
      classification: { className: 'dog' },
    })
  })

  it('still coalesces the ~30 Hz classifier stream — one row per heartbeat', async () => {
    booted = await bootAnalytics(DEVICE_ID, noNative, {
      deviceSettings: { audioEpisodeEnabled: false, audioConfirmHits: 1 },
    })

    // Ten chunks 32 ms apart: the same class, well inside one heartbeat.
    for (let i = 0; i < 10; i += 1) {
      emitAudio(booted.bus.bus, 10_000 + i * 32)
      await flush()
    }
    // …then one past the heartbeat, which must produce a second row.
    emitAudio(booted.bus.bus, 20_000)
    await flush()

    expect(bootedEventRows(booted, AUDIO_EVENTS_COLLECTION)).toHaveLength(2)
  })

  it('inserts immediately when the class CHANGES, without waiting for a heartbeat', async () => {
    booted = await bootAnalytics(DEVICE_ID, noNative, {
      deviceSettings: { audioEpisodeEnabled: false, audioConfirmHits: 1 },
    })

    emitAudio(booted.bus.bus, 10_000, 'dog')
    await flush()
    emitAudio(booted.bus.bus, 10_100, 'speech')
    await flush()

    const rows = bootedEventRows(booted, AUDIO_EVENTS_COLLECTION)
    expect(rows).toMatchObject([
      { classification: { className: 'dog' } },
      { classification: { className: 'speech' } },
    ])
  })

  it('opens NO synthetic audio track — the grouping is what the knob turns off', async () => {
    booted = await bootAnalytics(DEVICE_ID, noNative, {
      deviceSettings: { audioEpisodeEnabled: false, audioConfirmHits: 1 },
    })

    emitAudio(booted.bus.bus, 10_000)
    await flush()

    const tracks = [...(booted.settings.data.get(TRACKS_COLLECTION)?.values() ?? [])]
    expect(tracks.filter((t) => t['source'] === 'audio')).toHaveLength(0)
  })
})

describe('audioEpisodeEnabled: true (default)', () => {
  it('persists the classified AudioEvent through the episode path', async () => {
    booted = await bootAnalytics(DEVICE_ID, noNative, {
      deviceSettings: { audioEpisodeOpenHoldSec: 0, audioConfirmHits: 1 },
    })

    emitAudio(booted.bus.bus, 10_000)
    await flush()

    const rows = bootedEventRows(booted, AUDIO_EVENTS_COLLECTION)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      deviceId: DEVICE_ID,
      classification: { className: 'dog' },
    })
  })
})
