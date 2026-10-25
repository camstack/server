import { DeviceType } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { type Harness, makeHarness, T0 } from '../../__tests__/support/harness.js'
import { FIVE_MINUTES_MS } from '../../time/bucket-time.js'

let h: Harness
afterEach(async () => {
  await h.close()
})

const NODE = { kind: 'node', nodeId: 'hub' } as const
const POINTS = {
  name: 'level',
  subjectKind: 'device',
  kind: 'gauge',
  displayName: 'Level',
  ingest: 'points',
} as const
const BUCKETS = {
  name: 'load',
  subjectKind: 'node',
  kind: 'gauge',
  displayName: 'Load',
  ingest: 'buckets',
} as const

function point(key: string, ts: number, value = 1) {
  return { key, subject: { kind: 'device', deviceId: 1 } as const, scope: '', ts, value }
}
function bucket(key: string, start: number) {
  return {
    key,
    subject: NODE,
    scope: '',
    bucketStart: start,
    samples: 1,
    sum: 1,
    min: 1,
    max: 1,
    last: 1,
    lastTs: start,
  }
}

describe('declareSeries', () => {
  it('namespaces the key under the CALLER and is idempotent', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    const a = await h.runtime.ingest.declareSeries('alpha', POINTS)
    const again = await h.runtime.ingest.declareSeries('alpha', POINTS)
    expect(a.key).toBe('addon:alpha/level')
    expect(again.key).toBe(a.key)
    expect(h.runtime.registry.metric('addon:alpha/level')?.ownerAddon).toBe('alpha')
    expect(h.runtime.registry.allMetrics().filter((m) => m.key === a.key)).toHaveLength(1)
  })

  it('a declared metric is STORED under its key: it survives a restart and boots add no rows', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    const { key } = await h.runtime.ingest.declareSeries('alpha', POINTS)
    const rowsAfterFirstBoot = (await h.runtime.store.loadMetrics()).length
    await h.restart()
    await h.restart()
    // Not re-declared after the restarts: the row itself must carry the key.
    expect(h.runtime.registry.metric(key)?.ownerAddon).toBe('alpha')
    const stored = await h.runtime.store.loadMetrics()
    expect(stored).toHaveLength(rowsAfterFirstBoot)
    expect(stored.map((m) => m.key)).toContain(key)
  })

  it('drops metric rows an earlier build stored under an engine-minted key', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    await h.rd.door.upsertMany.mutate({
      namespace: 'device-history',
      collection: 'metrics',
      conflict: ['key'],
      records: [
        {
          data: {
            key: 'ignored',
            source: 'addon',
            owner_addon: 'alpha',
            subject_kind: 'device',
            kind: 'gauge',
            unit: null,
            display_name: 'stray',
            ingest: 'points',
            declared_at: 1,
          },
        },
      ],
    })
    await h.restart()
    const stored = await h.runtime.store.loadMetrics()
    expect(stored.every((m) => m.key.startsWith('cap:') || m.key.startsWith('addon:'))).toBe(true)
  })

  it('refuses a call whose caller the transport could not identify', async () => {
    h = await makeHarness()
    await expect(h.runtime.ingest.declareSeries(null, POINTS)).rejects.toThrow(/caller/)
  })
})

describe('record', () => {
  it('refuses a point for a key another addon owns, an undeclared key, and an unidentified caller', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    await h.runtime.ingest.declareSeries('alpha', POINTS)
    const key = 'addon:alpha/level'
    const stolen = await h.runtime.ingest.record('beta', [point(key, T0)])
    expect(stolen).toEqual({ accepted: 0, refused: [{ key, reason: 'not-owner', count: 1 }] })
    const anon = await h.runtime.ingest.record(null, [point(key, T0)])
    expect(anon.refused[0]?.reason).toBe('not-owner')
    const missing = await h.runtime.ingest.record('alpha', [point('addon:alpha/nope', T0)])
    expect(missing.refused[0]?.reason).toBe('undeclared')
    expect(h.runtime.status().ingest.refused).toMatchObject({ 'not-owner': 2, undeclared: 1 })
    await h.runtime.flushNow()
    expect(h.runtime.registry.all()).toHaveLength(0)
  })

  it('refuses a rate above one point per 10 s per series and accepts the next once the interval passed', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    await h.runtime.ingest.declareSeries('alpha', POINTS)
    const key = 'addon:alpha/level'
    const r = await h.runtime.ingest.record('alpha', [
      point(key, T0),
      point(key, T0 + 1_000),
      point(key, T0 + 8_500),
      point(key, T0 + 10_000),
      point(key, T0 + 20_000),
    ])
    expect(r.accepted).toBe(3)
    expect(r.refused).toEqual([{ key, reason: 'rate', count: 2 }])
  })

  // The `.50` shape: native-metrics samples every 10 s (`DEFAULT_CADENCE_SEC`)
  // with `Date.now()` on a `setInterval` tick, so a tick lands a millisecond
  // or two EARLY as often as late. 28 runners x 5 keys + the container = 141
  // points, all stamped with the tick's one timestamp — an early tick refused
  // the WHOLE batch (`accepted: 0, refused: { rate: 141 }`).
  it('accepts a whole 10 s-cadence node batch whose tick landed a few ms early', async () => {
    h = await makeHarness({})
    const runnerKeys = ['main', 'gc', 'lifetime', 'rss', 'processes']
    for (const name of [...runnerKeys, 'container']) {
      await h.runtime.ingest.declareSeries('native-metrics', {
        name,
        subjectKind: 'node',
        kind: 'gauge',
        displayName: name,
        ingest: 'points',
      })
    }
    const batch = (ts: number) => [
      ...Array.from({ length: 28 }, (_, i) => `runner-${i}`).flatMap((scope) =>
        runnerKeys.map((name) => ({
          key: `addon:native-metrics/${name}`,
          subject: NODE,
          scope,
          ts,
          value: 1,
        })),
      ),
      { key: 'addon:native-metrics/container', subject: NODE, scope: '', ts, value: 1 },
    ]
    expect(batch(T0)).toHaveLength(141)
    expect(await h.runtime.ingest.record('native-metrics', batch(T0))).toEqual({
      accepted: 141,
      refused: [],
    })
    // Ticks of a 10 s interval with timer jitter, early and late: every one lands.
    const jitter = [-1, 3, -2, -1, 0, 2, -3, -1]
    for (const [i, j] of jitter.entries()) {
      const ts = T0 + (i + 1) * 10_000 + j
      h.setNow(ts)
      expect(await h.runtime.ingest.record('native-metrics', batch(ts))).toEqual({
        accepted: 141,
        refused: [],
      })
    }
  })

  it('still bounds a faster producer to one point per 10 s, sustained', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    await h.runtime.ingest.declareSeries('alpha', POINTS)
    const key = 'addon:alpha/level'
    // A 9 s cadence for 90 s: the jitter slack must not become a 10 % rate raise.
    const points = Array.from({ length: 11 }, (_, i) => point(key, T0 + i * 9_000))
    const r = await h.runtime.ingest.record('alpha', points)
    expect(r.accepted).toBeLessThanOrEqual(1 + Math.floor((10 * 9_000) / 10_000))
    expect(r.refused[0]?.reason).toBe('rate')
  })

  it('refuses an opted-out device, a hub, a node-for-device mismatch and an out-of-range time', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor, 2: DeviceType.Hub } })
    await h.runtime.ingest.declareSeries('alpha', POINTS)
    const key = 'addon:alpha/level'
    await h.runtime.setEnabled(1, false)
    expect((await h.runtime.ingest.record('alpha', [point(key, T0)])).refused[0]?.reason).toBe(
      'opted-out',
    )
    await h.runtime.setEnabled(1, true)
    const hub = { ...point(key, T0), subject: { kind: 'device', deviceId: 2 } as const }
    expect((await h.runtime.ingest.record('alpha', [hub])).refused[0]?.reason).toBe(
      'not-a-real-device',
    )
    const node = { ...point(key, T0), subject: NODE }
    expect((await h.runtime.ingest.record('alpha', [node])).refused[0]?.reason).toBe('undeclared')
    const future = point(key, T0 + 3_600_000)
    const old = point(key, T0 - 30 * 86_400_000)
    const out = await h.runtime.ingest.record('alpha', [future, old])
    expect(out.refused).toEqual([{ key, reason: 'out-of-range', count: 2 }])
  })

  it('refuses a points call against a bucket series (ingest mismatch)', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    await h.runtime.ingest.declareSeries('alpha', BUCKETS)
    const bad = { ...point('addon:alpha/load', T0), subject: NODE }
    expect((await h.runtime.ingest.record('alpha', [bad])).refused[0]?.reason).toBe(
      'ingest-mismatch',
    )
  })

  it('stores accepted points and rolls them up like a captured series', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    await h.runtime.ingest.declareSeries('alpha', POINTS)
    const key = 'addon:alpha/level'
    await h.runtime.ingest.record('alpha', [point(key, T0, 4), point(key, T0 + 20_000, 6)])
    h.advance(FIVE_MINUTES_MS + 31_000)
    await h.settle()
    const series = h.runtime.registry.find(key, 'd:1', '')
    const rows = await h.runtime.store.readRollups(
      '5m',
      series?.id ?? -1,
      0,
      Number.MAX_SAFE_INTEGER,
      10,
    )
    expect(rows[0]).toMatchObject({ samples: 2, sum: 10, min: 4, max: 6, last: 6 })
  })
})

describe('recordBuckets', () => {
  it('refuses a bucket for a key another addon owns, a misaligned start and a future one', async () => {
    h = await makeHarness()
    await h.runtime.ingest.declareSeries('alpha', BUCKETS)
    const key = 'addon:alpha/load'
    const stolen = await h.runtime.ingest.recordBuckets('beta', [bucket(key, T0)])
    expect(stolen.refused[0]?.reason).toBe('not-owner')
    const bad = await h.runtime.ingest.recordBuckets('alpha', [
      bucket(key, T0 + 1),
      bucket(key, T0 + 3_600_000),
    ])
    expect(bad.refused).toEqual([{ key, reason: 'out-of-range', count: 2 }])
    expect(bad.accepted).toBe(0)
  })

  it('surfaces a store failure to the producer so it can re-queue', async () => {
    h = await makeHarness()
    await h.runtime.ingest.declareSeries('alpha', BUCKETS)
    await h.rd.backend.shutdown()
    await expect(
      h.runtime.ingest.recordBuckets('alpha', [bucket('addon:alpha/load', T0)]),
    ).rejects.toThrow()
  })
})
