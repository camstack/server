/**
 * The per-camera chart is where a reported cost turns into a drawn number, so
 * every way a drawn number can be a lie is asserted here:
 *
 * - a family that CANNOT be attributed to one camera being drawn per camera;
 * - a window nobody measured being filled with a zero, an interpolation, or
 *   the previous value;
 * - a lifetime average being drawn where a rate is promised;
 * - a counter differenced across a process restart, which on a recycled pid
 *   produces a plausible spike out of nothing.
 */
import { describe, expect, it } from 'vitest'
import type { CameraLoadEntry } from '../load/camera-load-fold'
import {
  appendCameraRates,
  chartableCameraRoles,
  isChartableContribution,
  orderCamerasByLoad,
  ratesBetween,
  type CameraLoadSeries,
  type ContributionReading,
} from '../load/camera-load-rates'

const T0 = 1_700_000_000_000
const CADENCE_MS = 10_000

function recorder(over: Partial<CameraLoadEntry> = {}): CameraLoadEntry {
  return {
    addonId: 'recorder',
    role: 'recording',
    deviceId: 101,
    attribution: 'measured',
    unit: '101/high',
    pid: 100,
    startedAtMs: T0 - 3_600_000,
    cpuSeconds: 100,
    rssBytes: 50_000_000,
    ...over,
  }
}

function reading(atMs: number, entries: readonly CameraLoadEntry[]): ContributionReading {
  return { atMs, entries }
}

describe('the chart gate — what may be drawn per camera', () => {
  it('draws exactly the families the attribution table declares readable', () => {
    // Not a hardcoded list: the assertion is that the gate and the table agree.
    expect([...chartableCameraRoles()].toSorted()).toEqual(['decode', 'recording', 'transcode'])
  })

  it('REFUSES detection, even when the entry names a camera', () => {
    // The shared inference pool serves every camera from one process. A
    // contributor may label an entry with the camera that triggered it; the
    // declaration must win, or the pool's whole cost lands on that camera and
    // is drawn on an axis that makes an estimate look measured.
    expect(
      isChartableContribution(
        recorder({
          addonId: 'detection-pipeline',
          role: 'detection',
          attribution: 'unattributable',
          unit: 'cuda:0 shared pool',
        }),
      ),
    ).toBe(false)
    // And even if a future contributor mislabelled it `measured`, the ROLE is
    // refused — the table, not the entry, decides what is drawable.
    expect(
      isChartableContribution(
        recorder({ addonId: 'detection-pipeline', role: 'detection', attribution: 'measured' }),
      ),
    ).toBe(false)
  })

  it('produces NO per-camera point for a detection contribution', () => {
    const pool = recorder({
      addonId: 'detection-pipeline',
      role: 'detection',
      attribution: 'unattributable',
      deviceId: null,
      unit: 'cuda:0 shared pool',
      pid: 200,
      cpuSeconds: 900,
    })
    const later = { ...pool, cpuSeconds: 1_800 }
    expect(ratesBetween(reading(T0, [pool]), reading(T0 + CADENCE_MS, [later]))).toEqual([])
  })

  it('REFUSES streaming — per-camera by construction, unreadable for most cameras', () => {
    // `wiredToday: false`. Only an ffmpeg-parser source spawns a child; a
    // native source has none. Drawing it would promise a number for every
    // camera and deliver one to a minority.
    expect(isChartableContribution(recorder({ role: 'streaming', unit: '101/native' }))).toBe(false)
    const before = recorder({ addonId: 'stream-broker', role: 'streaming', unit: '101/native' })
    const after = { ...before, cpuSeconds: 200 }
    expect(ratesBetween(reading(T0, [before]), reading(T0 + CADENCE_MS, [after]))).toEqual([])
  })
})

describe('CPU is a DELTA, never a lifetime average', () => {
  it('reports the rate over the window, not cpuSeconds ÷ uptime', () => {
    // The unit has been up an hour and accumulated 100 s: a lifetime average
    // would be 2.8 %. In THIS 10 s window it spent 4 s — 40 % of one core.
    // The ledger's warning about `ps pcpu` is exactly this difference: an
    // average over a long life is a flat line that cannot show a peak.
    const samples = ratesBetween(
      reading(T0, [recorder({ cpuSeconds: 100 })]),
      reading(T0 + CADENCE_MS, [recorder({ cpuSeconds: 104 })]),
    )
    expect(samples).toHaveLength(1)
    expect(samples[0]?.point.cpuPercent).toBe(40)
    expect(samples[0]?.point.cpuPercent).not.toBeCloseTo(2.8, 1)
  })

  it('sums the units of one camera and keeps its roles', () => {
    const decode = recorder({
      addonId: 'pipeline-runner',
      role: 'decode',
      unit: '101/detect',
      pid: 101,
      cpuSeconds: 10,
      rssBytes: 20_000_000,
    })
    const samples = ratesBetween(
      reading(T0, [recorder({ cpuSeconds: 100 }), decode]),
      reading(T0 + CADENCE_MS, [
        recorder({ cpuSeconds: 101 }),
        { ...decode, cpuSeconds: 11, rssBytes: 21_000_000 },
      ]),
    )
    expect(samples[0]?.point.cpuPercent).toBe(20)
    expect(samples[0]?.point.rssBytes).toBe(71_000_000)
    expect(samples[0]?.point.roles).toEqual(['decode', 'recording'])
    expect(samples[0]?.point.unitCount).toBe(2)
  })

  it('refuses a window with no duration rather than dividing by zero', () => {
    expect(ratesBetween(reading(T0, [recorder()]), reading(T0, [recorder()]))).toEqual([])
  })
})

describe('a gap stays a gap — never zero, never carried forward', () => {
  it('reports UNKNOWN when a unit restarted inside the window', () => {
    // Same pid, new incarnation: the counter restarted from zero. Differencing
    // across it yields a negative number on a quiet process and, on a recycled
    // pid running an already-busy ffmpeg, a large POSITIVE one that draws as a
    // spike nobody measured. `startedAtMs` is the incarnation marker.
    const before = recorder({ cpuSeconds: 100, startedAtMs: T0 - 3_600_000 })
    const after = recorder({ cpuSeconds: 4, startedAtMs: T0 + 2_000 })
    const [sample] = ratesBetween(reading(T0, [before]), reading(T0 + CADENCE_MS, [after]))
    expect(sample?.point.cpuPercent).toBeNull()
    // RSS is a reading of the CURRENT process and is still known — the two
    // quantities fail independently.
    expect(sample?.point.rssBytes).toBe(50_000_000)
  })

  it('reports UNKNOWN when a unit vanished between the two readings', () => {
    // We know when it started, never when it stopped, so its share of the
    // window cannot be known. Summing only the units that survived would
    // produce a smaller number indistinguishable from a complete one.
    const kept = recorder({ unit: '101/low', pid: 102, cpuSeconds: 10 })
    const [sample] = ratesBetween(
      reading(T0, [recorder({ cpuSeconds: 100 }), kept]),
      reading(T0 + CADENCE_MS, [{ ...kept, cpuSeconds: 11 }]),
    )
    expect(sample?.point.cpuPercent).toBeNull()
  })

  it('reports UNKNOWN for a unit that appeared without saying when it started', () => {
    const [sample] = ratesBetween(
      reading(T0, []),
      reading(T0 + CADENCE_MS, [recorder({ startedAtMs: undefined })]),
    )
    expect(sample?.point.cpuPercent).toBeNull()
  })

  it('counts the WHOLE counter of a unit that started inside the window', () => {
    // Exact, not an assumption: the process did not exist before startedAtMs,
    // so every second on its counter was spent in this window.
    const [sample] = ratesBetween(
      reading(T0, []),
      reading(T0 + CADENCE_MS, [recorder({ cpuSeconds: 2, startedAtMs: T0 + 5_000 })]),
    )
    expect(sample?.point.cpuPercent).toBe(20)
  })

  it('reports UNKNOWN rather than a partial sum when one unit has no counter', () => {
    const noCounter = recorder({ unit: '101/low', pid: 102, cpuSeconds: undefined })
    const [sample] = ratesBetween(
      reading(T0, [recorder({ cpuSeconds: 100 }), noCounter]),
      reading(T0 + CADENCE_MS, [recorder({ cpuSeconds: 104 }), noCounter]),
    )
    expect(sample?.point.cpuPercent).toBeNull()
  })

  it('leaves a HOLE in the series instead of filling it', () => {
    // Three windows, the middle one unmeasurable. The series must carry an
    // explicit null so the chart breaks its path there. A zero would say the
    // camera cost nothing; the previous value would claim a window nobody
    // measured.
    const w1 = ratesBetween(
      reading(T0, [recorder({ cpuSeconds: 100 })]),
      reading(T0 + CADENCE_MS, [recorder({ cpuSeconds: 104 })]),
    )
    const w2 = ratesBetween(
      reading(T0 + CADENCE_MS, [recorder({ cpuSeconds: 104 })]),
      reading(T0 + 2 * CADENCE_MS, [recorder({ cpuSeconds: 1, startedAtMs: T0 + 15_000 })]),
    )
    const w3 = ratesBetween(
      reading(T0 + 2 * CADENCE_MS, [recorder({ cpuSeconds: 1, startedAtMs: T0 + 15_000 })]),
      reading(T0 + 3 * CADENCE_MS, [recorder({ cpuSeconds: 3, startedAtMs: T0 + 15_000 })]),
    )
    let series: ReadonlyMap<number, CameraLoadSeries> = new Map()
    for (const window of [w1, w2, w3]) series = appendCameraRates(series, window)
    expect(series.get(101)?.points.map((p) => p.cpuPercent)).toEqual([40, null, 20])
  })
})

describe('the accumulated series', () => {
  it('never draws the same window twice', () => {
    const window = ratesBetween(
      reading(T0, [recorder({ cpuSeconds: 100 })]),
      reading(T0 + CADENCE_MS, [recorder({ cpuSeconds: 104 })]),
    )
    let series: ReadonlyMap<number, CameraLoadSeries> = new Map()
    series = appendCameraRates(series, window)
    series = appendCameraRates(series, window)
    expect(series.get(101)?.points).toHaveLength(1)
  })

  it('is pure — appending does not touch the map it was given', () => {
    const before: ReadonlyMap<number, CameraLoadSeries> = new Map()
    const after = appendCameraRates(
      before,
      ratesBetween(
        reading(T0, [recorder({ cpuSeconds: 100 })]),
        reading(T0 + CADENCE_MS, [recorder({ cpuSeconds: 104 })]),
      ),
    )
    expect(before.size).toBe(0)
    expect(after.size).toBe(1)
  })

  it('orders on the newest KNOWN point, so one broken window does not reshuffle the page', () => {
    const series = new Map<number, CameraLoadSeries>([
      [
        101,
        {
          deviceId: 101,
          points: [
            { atMs: T0, cpuPercent: 90, rssBytes: 1, unitCount: 1, roles: ['recording'] },
            { atMs: T0 + 1, cpuPercent: null, rssBytes: 1, unitCount: 1, roles: ['recording'] },
          ],
        },
      ],
      [
        102,
        {
          deviceId: 102,
          points: [
            { atMs: T0 + 1, cpuPercent: 10, rssBytes: 1, unitCount: 1, roles: ['recording'] },
          ],
        },
      ],
    ])
    expect(orderCamerasByLoad(series).map((s) => s.deviceId)).toEqual([101, 102])
  })
})
