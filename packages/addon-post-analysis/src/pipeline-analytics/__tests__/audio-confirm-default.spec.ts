/**
 * The shipped default — 2 occurrences inside 10 s — asserted on the ROW that
 * reaches the store, not on the pure window next door.
 *
 * The pure spec (`audio-confirm-window.spec.ts`) proves the arithmetic. This
 * proves the arithmetic is WIRED: the gate sits inside the classification
 * branch of `handleAudioResult`, and a defect that skipped it would leave the
 * pure spec perfectly green. A single-frame classification must produce no
 * audio row at all — that single frame is the false positive the operator
 * measured 26 of in 24 hours.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { AudioDetection, AudioResult, IEventBus } from '@camstack/types'
import { EventCategory, createEvent } from '@camstack/types'
import { AUDIO_EVENTS_COLLECTION } from '../store/event-store.js'
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
    windowId: `w-${timestamp}-${className}`,
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
      {
        deviceId: DEVICE_ID,
        frame: audioFrame(timestamp, className, score),
        nodeId: 'hub',
      },
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

describe('shipped default: 2 occurrences inside 10 s', () => {
  it('writes NO audio row for a lone classified frame', async () => {
    booted = await bootAnalytics(DEVICE_ID, noNative, {
      deviceSettings: { audioEpisodeOpenHoldSec: 0 },
    })
    emitAudio(booted.bus.bus, 1_000)
    await flush()
    expect(bootedEventRows(booted, AUDIO_EVENTS_COLLECTION)).toHaveLength(0)
  })

  it('writes the row once the same sound is heard a second time inside the window', async () => {
    booted = await bootAnalytics(DEVICE_ID, noNative, {
      deviceSettings: { audioEpisodeOpenHoldSec: 0 },
    })
    emitAudio(booted.bus.bus, 1_000)
    await flush()
    emitAudio(booted.bus.bus, 4_000)
    await flush()
    expect(bootedEventRows(booted, AUDIO_EVENTS_COLLECTION).length).toBeGreaterThan(0)
  })

  it('never confirms two DIFFERENT sounds against each other', async () => {
    booted = await bootAnalytics(DEVICE_ID, noNative, {
      deviceSettings: { audioEpisodeOpenHoldSec: 0 },
    })
    emitAudio(booted.bus.bus, 1_000, 'dog')
    await flush()
    emitAudio(booted.bus.bus, 3_000, 'speech')
    await flush()
    expect(bootedEventRows(booted, AUDIO_EVENTS_COLLECTION)).toHaveLength(0)
  })
})
