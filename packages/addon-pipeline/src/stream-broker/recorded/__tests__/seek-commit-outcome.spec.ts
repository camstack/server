import { describe, it, expect } from 'vitest'
import { RecordedFeeder } from '../recorded-feeder'

/**
 * C3 (2026-08-26 scrub-debug plan): ONE line per `seek()` call — the commit
 * accounting — that fires no matter how the commit ends: served, gap,
 * abandoned, or a raw thrown error. Before this, the ONLY lines a commit
 * could produce were `recorded:seek-ready` (success only),
 * `recorded:seek-abandoned` (superseded/disposed only, and only on ONE of
 * several silent exit points) and the gap lines — and a plain thrown error,
 * or an error on an ALREADY-abandoned commit, logged NOTHING. That silence is
 * exactly the shape of the 2026-08-26 stall: two commits reached
 * `playback:intent` and never `playback:ready`, with nothing in the feeder's
 * own logs saying why.
 *
 * Each test below disarms one specific exit path that used to be silent (or
 * covered by a different, conditional line) and checks `recorded:seek-outcome`
 * fires exactly once with the right `outcome`.
 */

interface LogLine {
  readonly msg: string
  readonly data: Record<string, unknown>
}

const AU = (ptsMs: number, key = false) => ({
  data: new Uint8Array([0, 0, 0, 1, key ? 0x26 : 0x02]),
  ptsMs,
  keyframe: key,
  codec: 'H265' as const,
})

const outcomesOf = (logs: readonly LogLine[]) =>
  logs.filter((l) => l.msg === 'recorded:seek-outcome')

describe('recorded:seek-outcome — one line per commit, unconditionally (C3)', () => {
  it('a SUCCESSFUL playing landing gets exactly one line, outcome=served', async () => {
    const logs: LogLine[] = []
    const feeder = new RecordedFeeder({
      deviceId: 99,
      profile: 'mid',
      locate: async () => ({
        kind: 'segment',
        startMs: 5000,
        durMs: 4000,
        bytes: 3,
      }),
      readBytes: async () => new Uint8Array([1, 2, 3]),
      demux: async () => [AU(0, true), AU(40)],
      sink: { pushAccessUnit: () => {} },
      onState: () => {},
      onPosition: () => {},
      onLog: (msg, data) => logs.push({ msg, data }),
    })
    await feeder.seek(6000)
    const outcomes = outcomesOf(logs)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.data).toMatchObject({
      outcome: 'served',
      state: 'playing',
    })
    feeder.dispose()
  })

  it('a SUCCESSFUL paused landing gets exactly one line, outcome=served state=paused', async () => {
    const logs: LogLine[] = []
    const feeder = new RecordedFeeder({
      deviceId: 99,
      profile: 'mid',
      locate: async () => ({
        kind: 'segment',
        startMs: 5000,
        durMs: 4000,
        bytes: 3,
      }),
      readBytes: async () => new Uint8Array([1, 2, 3]),
      demux: async () => [AU(0, true), AU(40)],
      sink: { pushAccessUnit: () => {} },
      onState: () => {},
      onPosition: () => {},
      onLog: (msg, data) => logs.push({ msg, data }),
    })
    feeder.setRate(0)
    await feeder.seek(6000)
    const outcomes = outcomesOf(logs)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.data).toMatchObject({
      outcome: 'served',
      state: 'paused',
    })
    feeder.dispose()
  })

  it('a GAP (no footage anywhere) gets exactly one line, outcome=gap', async () => {
    const logs: LogLine[] = []
    const feeder = new RecordedFeeder({
      deviceId: 99,
      profile: 'mid',
      locate: async () => ({ kind: 'gap', nearestEdgeMs: null }),
      readBytes: async () => new Uint8Array([1, 2, 3]),
      demux: async () => [],
      sink: { pushAccessUnit: () => {} },
      onState: () => {},
      onPosition: () => {},
      onLog: (msg, data) => logs.push({ msg, data }),
    })
    await feeder.seek(12000)
    const outcomes = outcomesOf(logs)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.data).toMatchObject({ outcome: 'gap', state: 'gap' })
    feeder.dispose()
  })

  it('a commit ABANDONED right after the FIRST locate (a previously-100%-silent exit) still gets its line', async () => {
    // Exercises the earliest `token !== this.seekToken` check in `seek()` —
    // right after the first `locate` resolves. Before C3 this exit was a bare
    // `return`: nothing named it, ever.
    const logs: LogLine[] = []
    let releaseFirstLocate: (() => void) | undefined
    const feeder = new RecordedFeeder({
      deviceId: 99,
      profile: 'mid',
      locate: async ({ epochMs }) => {
        if (epochMs === 1000) {
          await new Promise<void>((r) => {
            releaseFirstLocate = r
          })
        }
        return { kind: 'segment', startMs: epochMs, durMs: 4000, bytes: 3 }
      },
      readBytes: async () => new Uint8Array([1]),
      demux: async () => [AU(0, true)],
      sink: { pushAccessUnit: () => {} },
      onState: () => {},
      onPosition: () => {},
      onLog: (msg, data) => logs.push({ msg, data }),
    })

    const abandoned = feeder.seek(1000) // parks on the first locate
    await Promise.resolve()
    await feeder.seek(2000) // supersedes it — resolves fully, bumps the token
    releaseFirstLocate!() // now let the FIRST seek's locate resolve
    await abandoned

    const outcomes = outcomesOf(logs)
    expect(outcomes).toHaveLength(2) // one per commit — seek(1000) AND seek(2000)
    const abandonedLine = outcomes.find((l) => l.data.epochMs === 1000)
    expect(abandonedLine?.data).toMatchObject({
      outcome: 'abandoned',
      state: null,
      superseded: true,
    })
    const servedLine = outcomes.find((l) => l.data.epochMs === 2000)
    expect(servedLine?.data).toMatchObject({ outcome: 'served' })
    feeder.dispose()
  })

  it('a raw thrown error on a commit still owned by its token gets outcome=error (used to log NOTHING at all)', async () => {
    const logs: LogLine[] = []
    const feeder = new RecordedFeeder({
      deviceId: 99,
      profile: 'mid',
      locate: async () => ({
        kind: 'segment',
        startMs: 5000,
        durMs: 4000,
        bytes: 3,
      }),
      readBytes: async () => {
        throw new Error('disk fail')
      },
      demux: async () => [],
      sink: { pushAccessUnit: () => {} },
      onState: () => {},
      onPosition: () => {},
      onLog: (msg, data) => logs.push({ msg, data }),
    })
    await feeder.seek(6000)
    const outcomes = outcomesOf(logs)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.data).toMatchObject({
      outcome: 'error',
      state: 'error',
    })
    feeder.dispose()
  })
})
