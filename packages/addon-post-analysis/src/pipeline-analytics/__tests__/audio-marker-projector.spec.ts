/**
 * Audio-marker projector (D62) — the gates between "an audio frame arrived"
 * and "a synthetic track exists on the timeline".
 *
 * Every test here is one gate, and every gate is COUNTED when it drops a
 * frame that had already cleared the ones before it. A suppressed marker that
 * produces no line reads as "never happened", and that is how a live rule was
 * once unable to fire for 15 hours without anyone noticing.
 *
 * Covers:
 *  - an anomalous, loud, motion-free frame materializes exactly ONE marker
 *  - motion active → suppressed + counted (the gate the operator asked for)
 *  - cooldown / per-hour / per-day ceilings → suppressed + counted
 *  - disabled → evaluated, counted as `wouldFire`, never materialized
 *  - the window line carries tags.deviceId and the suppression counts
 *  - a confident class at the anomalous frame labels the marker
 *  - a materialize in flight cannot be re-entered
 */

import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  type AudioMarkerConfig,
  type AudioMarkerObservation,
  AudioMarkerProjector,
  type SyntheticMarkerSink,
} from '../services/audio-marker-projector.js'

const CFG: AudioMarkerConfig = {
  enabled: true,
  baselineMs: 60_000,
  silenceFloorDbfs: -55,
  minDbfs: -25,
  minDeviations: 4,
  minDeviationDb: 12,
  motionQuietMs: 20_000,
  cooldownMs: 120_000,
  maxPerHour: 3,
  maxPerDay: 12,
}

interface Harness {
  readonly projector: AudioMarkerProjector
  readonly materialized: Array<{ cameraId: number; source: string; kind: string }>
  readonly logs: Array<{ msg: string; extras: unknown }>
  setMotion(active: boolean): void
  /** Feed `n` quiet frames at 30 Hz so the baseline warms up. Returns the ms. */
  warm(deviceId: number, fromMs?: number): number
  /** Feed one loud frame. */
  spike(deviceId: number, atMs: number, dbfs?: number, cls?: AudioMarkerObservation): void
  /**
   * A CONTINUOUS 30 Hz stream — the only realistic shape for audio, and the
   * one the time-aware EWMA is designed for. `warmMs` of quiet, then `runMs`
   * more of quiet with a loud frame injected at each `spikesAt`. Yields the
   * event loop after each spike so a fire-and-forget materialize can settle.
   */
  stream(
    deviceId: number,
    cfg: AudioMarkerConfig,
    warmMs: number,
    runMs: number,
    spikesAt: readonly number[],
  ): Promise<number>
}

function harness(cfg: AudioMarkerConfig = CFG): Harness {
  const materialized: Array<{ cameraId: number; source: string; kind: string }> = []
  const logs: Array<{ msg: string; extras: unknown }> = []
  let motion = false
  let resolveNext: (() => void) | null = null

  const sink: SyntheticMarkerSink = {
    materialize: async (i) => {
      materialized.push({ cameraId: i.cameraId, source: i.source, kind: i.kind })
      if (resolveNext !== null) await new Promise<void>((r) => (resolveNext = r))
      return null
    },
  }
  const logger: IScopedLogger = {
    debug: () => {},
    info: (msg, extras) => void logs.push({ msg, extras }),
    warn: (msg, extras) => void logs.push({ msg, extras }),
    error: (msg, extras) => void logs.push({ msg, extras }),
    child: () => logger,
    withTags: () => logger,
  }
  const projector = new AudioMarkerProjector({
    sink,
    isMotionActive: () => motion,
    logger,
  })
  return {
    projector,
    materialized,
    logs,
    setMotion: (a) => void (motion = a),
    warm: (deviceId, fromMs = 0) => {
      let t = fromMs
      for (let i = 0; i < 2400; i += 1) {
        projector.observe({ deviceId, timestampMs: t, dbfs: -50 }, cfg)
        t += 33
      }
      return t
    },
    spike: (deviceId, atMs, dbfs = -8, obs) => {
      projector.observe({ ...obs, deviceId, timestampMs: atMs, dbfs }, cfg)
    },
    stream: async (deviceId, streamCfg, warmMs, runMs, spikesAt) => {
      const pending = new Set(spikesAt)
      let t = 0
      const end = warmMs + runMs
      while (t <= end) {
        let spiked = false
        for (const at of pending) {
          if (at >= t && at < t + 33) {
            projector.observe({ deviceId, timestampMs: at, dbfs: -8 }, streamCfg)
            pending.delete(at)
            spiked = true
          }
        }
        if (!spiked) projector.observe({ deviceId, timestampMs: t, dbfs: -50 }, streamCfg)
        else await new Promise<void>((r) => setImmediate(r))
        t += 33
      }
      return t
    },
  }
}

/** The counters the window line reports. */
function windowMeta(logs: Array<{ msg: string; extras: unknown }>): Record<string, unknown> {
  const line = logs.find((l) => l.msg === 'audio anomaly gate (window)')
  if (line === undefined) throw new Error('no window line')
  const e = line.extras
  if (typeof e !== 'object' || e === null) throw new Error('no extras')
  const meta = Reflect.get(e, 'meta')
  if (typeof meta !== 'object' || meta === null) throw new Error('no meta')
  return { ...meta }
}

function windowTags(logs: Array<{ msg: string; extras: unknown }>): unknown {
  const line = logs.find((l) => l.msg === 'audio anomaly gate (window)')
  if (line === undefined) throw new Error('no window line')
  const e = line.extras
  if (typeof e !== 'object' || e === null) throw new Error('no extras')
  return Reflect.get(e, 'tags')
}

describe('AudioMarkerProjector', () => {
  it('materializes ONE marker for an anomalous, loud, motion-free frame', async () => {
    const h = harness()
    const t = h.warm(101)
    h.spike(101, t)
    await vi.waitFor(() => expect(h.materialized).toHaveLength(1))
    expect(h.materialized[0]).toEqual({ cameraId: 101, source: 'audio', kind: 'audio' })
  })

  it('suppresses a qualifying frame while motion is active, and COUNTS it', async () => {
    const h = harness()
    const t = h.warm(101)
    h.setMotion(true)
    h.spike(101, t)
    // Force the window line out so the suppression is visible.
    h.projector.flush(t + 60_001)
    expect(h.materialized).toHaveLength(0)
    expect(windowMeta(h.logs)['suppressedMotion']).toBe(1)
    expect(windowMeta(h.logs)['materialized']).toBe(0)
  })

  it('every window line carries tags.deviceId with the numeric id', () => {
    const h = harness()
    const t = h.warm(102)
    h.setMotion(true)
    h.spike(102, t)
    h.projector.flush(t + 60_001)
    expect(windowTags(h.logs)).toEqual({ deviceId: 102 })
  })

  it('holds the cooldown between markers on one camera, and COUNTS the drops', async () => {
    const h = harness()
    // Spikes at +0 s, +30 s (inside the 120 s cooldown) and +150 s (past it),
    // laid over a CONTINUOUS 30 Hz quiet stream — which is what real audio is.
    const t = await h.stream(101, CFG, 60_000, 160_000, [60_000, 90_000, 210_000])
    expect(h.materialized).toHaveLength(2)
    h.projector.flush(t)
    expect(windowMeta(h.logs)['suppressedCooldown']).toBe(1)
  })

  it('holds the per-hour ceiling', async () => {
    const cfg = { ...CFG, cooldownMs: 1000, maxPerHour: 2 }
    const h = harness(cfg)
    const t = await h.stream(101, cfg, 60_000, 40_000, [60_000, 70_000, 80_000, 90_000])
    expect(h.materialized).toHaveLength(2)
    h.projector.flush(t)
    expect(windowMeta(h.logs)['suppressedHourly']).toBe(2)
  })

  it('holds the per-day ceiling before the hourly ceiling can bind', async () => {
    const cfg = { ...CFG, cooldownMs: 1000, maxPerHour: 100, maxPerDay: 2 }
    const h = harness(cfg)
    const t = await h.stream(101, cfg, 60_000, 40_000, [60_000, 70_000, 80_000])
    expect(h.materialized).toHaveLength(2)
    h.projector.flush(t)
    expect(windowMeta(h.logs)['suppressedDaily']).toBe(1)
  })

  it('when DISABLED it still evaluates and reports wouldFire, but never materializes', () => {
    const cfg = { ...CFG, enabled: false }
    const h = harness(cfg)
    let t = 0
    for (let i = 0; i < 2400; i += 1) {
      h.projector.observe({ deviceId: 101, timestampMs: t, dbfs: -50 }, cfg)
      t += 33
    }
    h.projector.observe({ deviceId: 101, timestampMs: t, dbfs: -8 }, cfg)
    h.projector.flush(t + 61_000)
    expect(h.materialized).toHaveLength(0)
    // The whole point: the operator sizes the rate BEFORE enabling it.
    expect(windowMeta(h.logs)['wouldFire']).toBe(1)
    expect(windowMeta(h.logs)['enabled']).toBe(false)
  })

  it('labels the marker with the class heard on the anomalous frame', async () => {
    const materialized: Array<{ audioLabels?: readonly { label: string }[] }> = []
    const logger: IScopedLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => logger,
      withTags: () => logger,
    }
    const projector = new AudioMarkerProjector({
      sink: {
        materialize: async (i) => {
          materialized.push(i.audioLabels === undefined ? {} : { audioLabels: i.audioLabels })
          return null
        },
      },
      isMotionActive: () => false,
      logger,
    })
    let t = 0
    for (let i = 0; i < 2400; i += 1) {
      projector.observe({ deviceId: 101, timestampMs: t, dbfs: -50 }, CFG)
      t += 33
    }
    projector.observe(
      { deviceId: 101, timestampMs: t, dbfs: -8, className: 'dog', score: 0.91 },
      CFG,
    )
    await vi.waitFor(() => expect(materialized).toHaveLength(1))
    expect(materialized[0]?.audioLabels).toEqual([
      { label: 'dog', peakScore: 0.91, count: 1, firstAt: t, lastAt: t },
    ])
  })

  it('does not silently drop a quiet camera into the log — no candidates, no line', () => {
    const h = harness()
    const t = h.warm(101)
    // No spike. Nothing qualified; the window must stay quiet rather than
    // emitting a line per camera per minute forever.
    h.projector.flush(t + 60_001)
    expect(h.logs.filter((l) => l.msg === 'audio anomaly gate (window)')).toHaveLength(0)
  })
})
