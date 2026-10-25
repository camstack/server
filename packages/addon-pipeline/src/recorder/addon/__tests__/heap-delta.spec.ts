/**
 * The heap-delta probe: when one unit of work is worth a line.
 *
 * Every recorder lifetime builds ~2.3 GB in one silent phase 3–5 min after
 * boot (~910 MB of it large-object space) and no line has ever said which
 * pass, boot phase or inbound call does it. The probe is the instrument that
 * will. Its only decision is the threshold, and a threshold that is wrong in
 * either direction is useless: too eager and the line is noise on every
 * 30 s pass, too shy and the build phase goes by silent again.
 */
import { describe, expect, it } from 'vitest'
import { startPeriodicPass } from '../periodic-pass.js'
import {
  DEFAULT_HEAP_DELTA_THRESHOLDS,
  type HeapSample,
  HeapDeltaProbe,
  judgeHeapDelta,
} from '../heap-delta.js'

const MIB = 1024 * 1024
const T = DEFAULT_HEAP_DELTA_THRESHOLDS

function sample(heapMb: number, losMb: number | null): HeapSample {
  return { heapUsedBytes: heapMb * MIB, largeObjectBytes: losMb === null ? null : losMb * MIB }
}

describe('judgeHeapDelta — the threshold', () => {
  it('stays silent below every bar', () => {
    const verdict = judgeHeapDelta(sample(100, 50), sample(149, 99), 4_999, T)
    expect(verdict.reasons).toEqual([])
  })

  it('reports growth of heapUsed at the bar (50 MB)', () => {
    expect(judgeHeapDelta(sample(100, 50), sample(150, 50), 10, T).reasons).toEqual(['heap'])
  })

  it('reports growth of large-object space on its own', () => {
    expect(judgeHeapDelta(sample(100, 50), sample(120, 100), 10, T).reasons).toEqual([
      'large-object-space',
    ])
  })

  it('reports a slow unit whatever it did to the heap', () => {
    expect(judgeHeapDelta(sample(100, 50), sample(100, 50), 5_000, T).reasons).toEqual(['duration'])
  })

  it('does NOT report a shrink — a unit that straddled a GC retained nothing we can see', () => {
    expect(judgeHeapDelta(sample(900, 900), sample(100, 100), 10, T).reasons).toEqual([])
  })

  it('never turns a failed read into a zero delta', () => {
    const verdict = judgeHeapDelta(null, sample(900, 900), 10, T)
    expect(verdict).toEqual({ reasons: [], heapDeltaBytes: null, largeObjectDeltaBytes: null })
    const noLos = judgeHeapDelta(sample(100, null), sample(200, 50), 10, T)
    expect(noLos.largeObjectDeltaBytes).toBeNull()
    expect(noLos.reasons).toEqual(['heap'])
  })
})

interface Line {
  readonly message: string
  readonly meta: Record<string, unknown> | undefined
}

/** A probe over a scripted sequence of samples and a scripted clock. */
function makeProbe(samples: readonly (HeapSample | null)[], clockSteps: readonly number[]) {
  const lines: Line[] = []
  let s = 0
  let c = 0
  let clock = 0
  const probe = new HeapDeltaProbe({
    logger: {
      info: (message, extras) => {
        lines.push({ message, meta: extras?.meta })
      },
    },
    sampler: () => samples[s++] ?? null,
    now: () => {
      clock += clockSteps[c++] ?? 0
      return clock
    },
  })
  return { probe, lines }
}

describe('HeapDeltaProbe — one line per unit that grew the heap', () => {
  it('names the unit, with before/after/delta in MB, when it crosses the bar', async () => {
    const { probe, lines } = makeProbe([sample(50, 20), sample(950, 930)], [0, 1_200])
    const out = await probe.track({ kind: 'pass', name: 'hour-adoption' }, async () => 'done')

    expect(out).toBe('done')
    expect(lines).toHaveLength(1)
    expect(lines[0]?.message).toBe('recorder: unit of work moved the heap')
    expect(lines[0]?.meta).toMatchObject({
      kind: 'pass',
      name: 'hour-adoption',
      reasons: ['heap', 'large-object-space'],
      durationMs: 1_200,
      heapBeforeMb: 50,
      heapAfterMb: 950,
      heapDeltaMb: 900,
      losBeforeMb: 20,
      losAfterMb: 930,
      losDeltaMb: 910,
      inFlight: 0,
      failed: false,
    })
  })

  it('says nothing for a unit under every bar', async () => {
    const { probe, lines } = makeProbe([sample(50, 20), sample(60, 20)], [0, 100])
    await probe.track({ kind: 'pass', name: 'liveness' }, async () => undefined)
    expect(lines).toEqual([])
  })

  it('still measures — and rethrows — a unit that fails', async () => {
    const { probe, lines } = makeProbe([sample(50, 20), sample(500, 20)], [0, 10])
    await expect(
      probe.track({ kind: 'boot-phase', name: 'ledger-load' }, async () => {
        throw new Error('store down')
      }),
    ).rejects.toThrow('store down')
    expect(lines[0]?.meta).toMatchObject({ name: 'ledger-load', failed: true })
  })

  it('wraps every provider method, keeps `this`, and names the cap method', async () => {
    const { probe, lines } = makeProbe([sample(50, 20), sample(400, 20)], [0, 10])
    class Provider {
      private readonly rows = 3
      async listSegments(input: { readonly deviceId: number }): Promise<number> {
        return input.deviceId + this.rows
      }
    }
    const wrapped = probe.wrapProvider('recording-archive', new Provider())

    expect(await wrapped.listSegments({ deviceId: 101 })).toBe(104)
    expect(lines[0]?.meta).toMatchObject({
      kind: 'cap-method',
      name: 'recording-archive.listSegments',
    })
    // Same wrapper on every read, so identity comparisons still hold.
    expect(wrapped.listSegments).toBe(wrapped.listSegments)
    // Object's own surface passes through untouched.
    expect(wrapped.constructor).toBe(Provider)
  })

  it('reports the most other units open at any point during this one', async () => {
    const { probe, lines } = makeProbe(
      // outer begins, inner begins, inner ends (grew), outer ends (grew)
      [sample(50, 20), sample(50, 20), sample(500, 20), sample(500, 20)],
      [0, 0, 0, 10],
    )
    let release: () => void = () => {}
    const outer = probe.track(
      { kind: 'pass', name: 'outer' },
      () => new Promise<void>((resolve) => (release = resolve)),
    )
    await probe.track({ kind: 'pass', name: 'inner' }, async () => undefined)
    release()
    await outer
    // The overlap is visible from BOTH windows. The old start-only counter
    // reported outer=0 and hid every unit that began after the outer one.
    expect(lines.find((l) => l.meta?.['name'] === 'inner')?.meta).toMatchObject({ inFlight: 1 })
    expect(lines.find((l) => l.meta?.['name'] === 'outer')?.meta).toMatchObject({ inFlight: 1 })
  })
})

describe('startPeriodicPass — a pass is measured when a probe is given', () => {
  it('runs through the probe under the pass name', async () => {
    const tracked: string[] = []
    const handle = startPeriodicPass({
      name: 'reconcile',
      intervalMs: 3_600_000,
      slowAfterMs: 3_600_000,
      run: async () => undefined,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        child: () => {
          throw new Error('unused')
        },
        withTags: () => {
          throw new Error('unused')
        },
      },
      heapProbe: {
        track: async (unit, run) => {
          tracked.push(`${unit.kind}:${unit.name}`)
          return run()
        },
      },
    })
    handle.fireNow()
    await Promise.resolve()
    handle.stop()
    expect(tracked).toEqual(['pass:reconcile'])
  })
})
