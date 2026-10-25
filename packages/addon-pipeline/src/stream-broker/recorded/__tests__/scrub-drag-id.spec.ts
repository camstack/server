import { describe, it, expect } from 'vitest'
import { RecordedFeeder } from '../recorded-feeder'

/**
 * C1 (2026-08-26 scrub-debug plan): a `dragId` the client generates once per
 * gesture, threaded through `beginScrub` and the commit `seek`, printed on
 * EVERY log line of the scrub and the commit. The point is a join key that
 * does not depend on ordering `[app:*]` lines (phone clock) against feeder
 * lines (hub clock) — see the plan's rationale. This file proves the server
 * half: propagation is correct, and a feeder with no dragId at all (an older
 * viewer, or a plain seek) behaves byte-identically to before.
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

function harness() {
  const logs: LogLine[] = []
  const locate = async ({ epochMs }: { epochMs: number }) => ({
    kind: 'segment' as const,
    startMs: Math.floor(epochMs / 1000) * 1000,
    durMs: 1000,
    bytes: 3,
  })
  const readGop = async ({ epochMs }: { epochMs: number }) => ({
    gopStartMs: Math.floor(epochMs / 1000) * 1000,
    gopDurMs: 1000,
    bytes: new Uint8Array(1000),
  })
  const demux = async () => [AU(0, true), AU(40), AU(80)]
  const deps = {
    deviceId: 102,
    profile: 'low',
    locate,
    readBytes: async () => new Uint8Array(1000),
    readGop,
    demux,
    sink: { pushAccessUnit: () => {} },
    onState: () => {},
    onPosition: () => {},
    onLog: (msg: string, data: Record<string, unknown>) => logs.push({ msg, data }),
  }
  return { deps, logs }
}

const linesOf = (logs: readonly LogLine[], msg: string) => logs.filter((l) => l.msg === msg)
const dragIdsOf = (lines: readonly LogLine[]) => lines.map((l) => l.data.dragId)

describe('scrub dragId propagation (C1)', () => {
  it('every scrub-feeder line AND the commit line of one drag carry the SAME dragId, start to finish', async () => {
    const { deps, logs } = harness()
    const feeder = new RecordedFeeder(deps)
    feeder.beginScrub('drag-A')
    feeder.scrubTo(100_500, { mode: 'coarse', velocityPxPerS: 500 })
    await new Promise<void>((r) => setTimeout(r, 5))
    feeder.scrubAck()
    await feeder.seek(100_600, { dragId: 'drag-A' }) // the commit

    const pushed = linesOf(logs, 'scrub-feeder:pushed')
    const dragEnd = linesOf(logs, 'scrub-feeder:drag-end')
    const outcome = linesOf(logs, 'recorded:seek-outcome')
    expect(pushed.length).toBeGreaterThan(0)
    expect(dragEnd).toHaveLength(1)
    expect(outcome).toHaveLength(1)
    for (const line of [...pushed, ...dragEnd, ...outcome]) {
      expect(line.data.dragId).toBe('drag-A')
    }
    feeder.dispose()
  })

  it('a SECOND drag on the same feeder gets its OWN id — the first never leaks into it', async () => {
    const { deps, logs } = harness()
    const feeder = new RecordedFeeder(deps)

    feeder.beginScrub('drag-A')
    feeder.scrubTo(100_500, { mode: 'coarse', velocityPxPerS: 500 })
    await new Promise<void>((r) => setTimeout(r, 5))
    feeder.scrubAck()
    await feeder.seek(100_600, { dragId: 'drag-A' })

    feeder.beginScrub('drag-B')
    feeder.scrubTo(200_500, { mode: 'coarse', velocityPxPerS: 500 })
    await new Promise<void>((r) => setTimeout(r, 5))
    feeder.scrubAck()
    await feeder.seek(200_600, { dragId: 'drag-B' })

    const dragEnds = linesOf(logs, 'scrub-feeder:drag-end')
    expect(dragEnds).toHaveLength(2)
    expect(dragEndDragIds(dragEnds)).toEqual(['drag-A', 'drag-B'])

    // No line anywhere in the WHOLE log carries a mismatched pairing — every
    // dragId that appears is one of exactly the two the test issued.
    const allDragIds = new Set(logs.map((l) => l.data.dragId).filter((v) => v !== undefined))
    expect([...allDragIds].sort()).toEqual(['drag-A', 'drag-B'])
    feeder.dispose()
  })

  it('a feeder that never receives a dragId behaves identically — every line simply carries none', async () => {
    const { deps, logs } = harness()
    const feeder = new RecordedFeeder(deps)
    feeder.beginScrub() // no dragId — the optional, back-compat case
    feeder.scrubTo(100_500, { mode: 'coarse', velocityPxPerS: 500 })
    await new Promise<void>((r) => setTimeout(r, 5))
    feeder.scrubAck()
    await feeder.seek(100_600) // no SeekOptions at all — a bare commit

    const dragEnd = linesOf(logs, 'scrub-feeder:drag-end')
    const outcome = linesOf(logs, 'recorded:seek-outcome')
    expect(dragEnd).toHaveLength(1)
    expect(outcome).toHaveLength(1)
    expect(dragEnd[0]!.data.dragId).toBeUndefined()
    expect(outcome[0]!.data.dragId).toBeUndefined()
    // And the drag still ran and served a frame — dragId is pure observability.
    expect(outcome[0]!.data.outcome).toBe('served')
    feeder.dispose()
  })
})

function dragEndDragIds(lines: readonly LogLine[]): unknown[] {
  return dragIdsOf(lines)
}
