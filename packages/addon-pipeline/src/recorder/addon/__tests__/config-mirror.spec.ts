/**
 * The recorder's `RecordingConfig` read is a MIRROR, not a per-event round trip.
 *
 * Two behaviours are pinned here and they pull in opposite directions, which is
 * why both are tested:
 *
 *  1. **A read on the trigger path costs nothing.** `onAudioLevel`,
 *     `postBufferMsFor` and `evaluateDevice` each read the config once per
 *     event, and on 2026-09-11 that measured **1 500-1 820 `get
 *     recorder:recording-configs` a minute** on the live hub — ~40 % of every
 *     call the whole cluster made to `hub/sqlite-settings`, for a row that
 *     changes when an operator edits a band.
 *  2. **An operator's edit is never served late.** The mirror's owner writes
 *     THROUGH it (`put`), so the value that was just persisted is the value the
 *     next decision uses — a freshness window that delayed an edit would be the
 *     D224 failure ("stale by design on the one write an operator makes")
 *     arriving in a different file.
 *
 * And the behaviour this module already had, unchanged: a read that FAILS is
 * not a read that returned nothing (2026-08-25, 57 `trigger history using the
 * DEFAULT post-buffer` lines on correctly configured cameras).
 */
import type { IScopedLogger, RecordingConfig } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { createRecordingConfigMirror } from '../config-mirror'

interface LoggedLine {
  readonly message: string
  readonly meta: Record<string, unknown>
  readonly deviceId: number | undefined
}

function recordingLogger(sink: LoggedLine[]): IScopedLogger {
  const capture = (message: string, ctx?: unknown): void => {
    const c = (ctx ?? {}) as {
      meta?: Record<string, unknown>
      tags?: { deviceId?: number }
    }
    sink.push({ message, meta: c.meta ?? {}, deviceId: c.tags?.deviceId })
  }
  const logger = {
    info: capture,
    warn: capture,
    error: capture,
    debug: capture,
    child: () => logger,
  }
  return logger as unknown as IScopedLogger
}

/** Two configs that differ in the field the outage got wrong: the band. */
function configWithPostBuffer(postBufferSec: number): RecordingConfig {
  return {
    enabled: true,
    bands: [{ kind: 'events', days: [0, 1, 2, 3, 4, 5, 6], postBufferSec }],
  } as unknown as RecordingConfig
}

describe('createRecordingConfigMirror — the hot path', () => {
  it('answers a burst of trigger-path reads with ONE store round trip', async () => {
    const config = configWithPostBuffer(120)
    const load = vi.fn<(deviceId: number) => Promise<RecordingConfig>>().mockResolvedValue(config)
    let clock = 1_000
    const mirror = createRecordingConfigMirror({
      load,
      logger: recordingLogger([]),
      now: () => clock,
      freshMs: 30_000,
    })

    // One audio window every 500 ms for 10 s — the live cadence of
    // `PipelineAudioInferenceResult` on one camera.
    for (let i = 0; i < 20; i++) {
      clock += 500
      await expect(mirror.read(102)).resolves.toBe(config)
    }

    expect(load).toHaveBeenCalledTimes(1)
  })

  it('goes back to the store once the freshness window has passed', async () => {
    const first = configWithPostBuffer(120)
    const second = configWithPostBuffer(300)
    const load = vi
      .fn<(deviceId: number) => Promise<RecordingConfig>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValue(second)
    let clock = 1_000
    const mirror = createRecordingConfigMirror({
      load,
      logger: recordingLogger([]),
      now: () => clock,
      freshMs: 30_000,
    })

    await expect(mirror.read(102)).resolves.toBe(first)
    clock += 29_999
    await expect(mirror.read(102)).resolves.toBe(first)
    clock += 2
    await expect(mirror.read(102)).resolves.toBe(second)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('keeps cameras independent — one camera fresh does not answer for another', async () => {
    const load = vi
      .fn<(deviceId: number) => Promise<RecordingConfig>>()
      .mockImplementation(async (deviceId: number) => configWithPostBuffer(deviceId))
    const mirror = createRecordingConfigMirror({ load, logger: recordingLogger([]) })

    const a = await mirror.read(102)
    const b = await mirror.read(101)
    expect(a).not.toBe(b)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('serves an operator edit IMMEDIATELY through the owner write, never a window late', async () => {
    const before = configWithPostBuffer(120)
    const after = configWithPostBuffer(300)
    const load = vi.fn<(deviceId: number) => Promise<RecordingConfig>>().mockResolvedValue(before)
    let clock = 1_000
    const mirror = createRecordingConfigMirror({
      load,
      logger: recordingLogger([]),
      now: () => clock,
      freshMs: 30_000,
    })

    await expect(mirror.read(102)).resolves.toBe(before)
    // The recorder is the ONLY writer of this row; `setDeviceConfig` hands the
    // persisted value straight to the mirror. Zero elapsed time — the edit must
    // be visible on the very next decision.
    mirror.put(102, after)
    await expect(mirror.read(102)).resolves.toBe(after)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('invalidate sends the next read to the store', async () => {
    const config = configWithPostBuffer(120)
    const load = vi.fn<(deviceId: number) => Promise<RecordingConfig>>().mockResolvedValue(config)
    const mirror = createRecordingConfigMirror({ load, logger: recordingLogger([]) })

    await mirror.read(102)
    mirror.invalidate(102)
    await mirror.read(102)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('states what it served and what it cost, once per window', async () => {
    const config = configWithPostBuffer(120)
    const load = vi.fn<(deviceId: number) => Promise<RecordingConfig>>().mockResolvedValue(config)
    const lines: LoggedLine[] = []
    let clock = 1_000
    const mirror = createRecordingConfigMirror({
      load,
      logger: recordingLogger(lines),
      now: () => clock,
      freshMs: 30_000,
      reportIntervalMs: 60_000,
    })

    await mirror.read(102)
    for (let i = 0; i < 9; i++) await mirror.read(102)
    expect(lines.filter((l) => l.message.includes('config mirror'))).toHaveLength(0)

    clock += 60_001
    await mirror.read(102)
    const report = lines.find((l) => l.message.includes('config mirror'))
    expect(report).toBeDefined()
    // 10 reads answered from RAM, 1 store round trip, and the window it covers.
    expect(report?.meta['served']).toBe(9)
    expect(report?.meta['storeReads']).toBe(1)
    expect(report?.meta['devices']).toBe(1)
  })
})

describe('createRecordingConfigMirror — a failed read is not an empty one', () => {
  it('serves the last SUCCESSFUL config when the read fails — not the shipped default', async () => {
    const operatorConfig = configWithPostBuffer(120)
    const load = vi
      .fn<(deviceId: number) => Promise<RecordingConfig>>()
      .mockResolvedValueOnce(operatorConfig)
      .mockRejectedValueOnce(new Error('UDS request timed out after 60000ms'))
    const lines: LoggedLine[] = []
    let clock = 1_000
    const mirror = createRecordingConfigMirror({
      load,
      logger: recordingLogger(lines),
      now: () => clock,
      freshMs: 30_000,
    })

    await expect(mirror.read(102)).resolves.toBe(operatorConfig)
    clock += 40_000
    // The read fails. The operator's 120 s post-buffer must still be what the
    // recorder uses — this is the assertion the live bug violated.
    await expect(mirror.read(102)).resolves.toBe(operatorConfig)

    const fallback = lines.find((l) => l.message.includes('LAST-KNOWN-GOOD'))
    expect(fallback).toBeDefined()
    // Every line about a device carries the numeric id, or a per-camera
    // question ("why is 102 worse than 101?") cannot be answered.
    expect(fallback?.deviceId).toBe(102)
    // Staleness is not hidden — it is reported, because that is what makes an
    // outage visible without a TTL that would restore the wrong answer.
    expect(fallback?.meta['ageMs']).toBe(40_000)
  })

  it('rethrows when the camera has NEVER been read — an invented answer is worse than none', async () => {
    const load = vi
      .fn<(deviceId: number) => Promise<RecordingConfig>>()
      .mockRejectedValue(new Error('UDS request timed out after 60000ms'))
    const lines: LoggedLine[] = []
    const mirror = createRecordingConfigMirror({ load, logger: recordingLogger(lines) })

    await expect(mirror.read(101)).rejects.toThrow('UDS request timed out')
    const line = lines.find((l) => l.message.includes('NOTHING is cached'))
    expect(line?.deviceId).toBe(101)
  })

  it('never lets a failure overwrite good state, and keeps cameras independent', async () => {
    const good617 = configWithPostBuffer(120)
    const good615 = configWithPostBuffer(30)
    const load = vi.fn<(deviceId: number) => Promise<RecordingConfig>>(async (deviceId: number) => {
      if (deviceId === 102) return good617
      throw new Error('UDS request timed out after 60000ms')
    })
    let clock = 1_000
    const mirror = createRecordingConfigMirror({
      load,
      logger: recordingLogger([]),
      now: () => clock,
      freshMs: 30_000,
    })

    await expect(mirror.read(102)).resolves.toBe(good617)
    // 101 failing must not disturb 102's cached value.
    await expect(mirror.read(101)).rejects.toThrow()
    load.mockImplementation(async () => {
      throw new Error('UDS request timed out after 60000ms')
    })
    clock += 40_000
    await expect(mirror.read(102)).resolves.toBe(good617)
    expect(good615.enabled).toBe(true)
  })

  it('refreshes on every store success, so the fallback tracks the operator', async () => {
    const oldConfig = configWithPostBuffer(120)
    const newConfig = configWithPostBuffer(300)
    const load = vi
      .fn<(deviceId: number) => Promise<RecordingConfig>>()
      .mockResolvedValueOnce(oldConfig)
      .mockResolvedValueOnce(newConfig)
      .mockRejectedValueOnce(new Error('UDS request timed out after 60000ms'))
    let clock = 1_000
    const mirror = createRecordingConfigMirror({
      load,
      logger: recordingLogger([]),
      now: () => clock,
      freshMs: 30_000,
    })

    await mirror.read(102)
    clock += 40_000
    await mirror.read(102)
    clock += 40_000
    // The operator edited the band between the two reads; the fallback must
    // serve the EDIT, not the first value ever seen.
    await expect(mirror.read(102)).resolves.toBe(newConfig)
  })
})
