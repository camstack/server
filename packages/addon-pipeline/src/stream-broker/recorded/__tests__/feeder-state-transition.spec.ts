import { describe, it, expect } from 'vitest'
import { RecordedFeeder, type FeederStateTransition } from '../recorded-feeder'

/**
 * C2 (2026-08-26 scrub-debug plan): `onState` used to carry a naked string —
 * `recorded: feeder state = loading` said nothing about where it came from,
 * why, or which commit it belonged to. A state that got STUCK there (the
 * 2026-08-26 incident: two commits reached `playback:intent` and never
 * `playback:ready`) could not be explained from the feeder's own logs.
 *
 * `onState` now reports `{ from, to, reason, seekToken, dragId }`. This file
 * proves the contract holds, and — the actual bar the plan sets — that a
 * stuck transition is reconstructible from the transition records ALONE, with
 * no wall-clock ordering required.
 */

const AU = (ptsMs: number, key = false) => ({
  data: new Uint8Array([0, 0, 0, 1, key ? 0x26 : 0x02]),
  ptsMs,
  keyframe: key,
  codec: 'H265' as const,
})

describe('FeederStateTransition (C2)', () => {
  it('the FIRST transition of a fresh feeder has from: null, and to/reason/seekToken are populated', async () => {
    const transitions: FeederStateTransition[] = []
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
      onState: (t) => transitions.push(t),
      onPosition: () => {},
    })
    await feeder.seek(6000)

    expect(transitions.length).toBeGreaterThanOrEqual(2)
    const first = transitions[0]!
    expect(first.from).toBeNull()
    expect(first.to).toBe('loading')
    expect(first.reason).toBe('seek-start')
    expect(typeof first.seekToken).toBe('number')
    // `from` chains: the SECOND transition's `from` is the first's `to`.
    const second = transitions[1]!
    expect(second.from).toBe(first.to)
    feeder.dispose()
  })

  it('a commit that lands paused reports reason seek-landed-paused, and every line of THAT commit shares its own seekToken', async () => {
    const transitions: FeederStateTransition[] = []
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
      onState: (t) => transitions.push(t),
      onPosition: () => {},
    })
    feeder.setRate(0) // rate-zero on a fresh feeder — its OWN transition, token 0
    await feeder.seek(6000) // the commit — a NEW token, distinct from rate-zero's

    const last = transitions.at(-1)!
    expect(last).toMatchObject({ to: 'paused', reason: 'seek-landed-paused' })
    // Every transition produced BY THIS COMMIT (i.e. everything after the
    // rate-zero one) shares exactly one seekToken — the commit's own.
    const commitTransitions = transitions.slice(1)
    const commitTokens = new Set(commitTransitions.map((t) => t.seekToken))
    expect(commitTokens.size).toBe(1)
    expect(last.seekToken).toBe([...commitTokens][0])
    feeder.dispose()
  })

  it('a stuck commit is reconstructible from the transition records ALONE — no clock needed', async () => {
    // Mirrors "RecordedFeeder seek abandonment (latest-wins)" but captures the
    // FULL transition instead of reducing it to a string, and asserts the
    // property C2 exists for: given only `{to, seekToken}` pairs (no
    // timestamps), you can name which commit is stuck and which superseded it.
    const transitions: FeederStateTransition[] = []
    const feeder = new RecordedFeeder({
      deviceId: 99,
      profile: 'mid',
      locate: async ({ epochMs }) => ({
        kind: 'segment',
        startMs: epochMs,
        durMs: 1_000_000,
        bytes: 3,
      }),
      readBytes: async ({ startMs }) => {
        if (startMs === 6000) return new Promise<Uint8Array>(() => {}) // seek#1: hangs forever
        return new Uint8Array([2]) // seek#2
      },
      demux: async (bytes) => [{ data: bytes, ptsMs: 0, keyframe: true, codec: 'H265' as const }],
      sink: { pushAccessUnit: () => {} },
      onState: (t) => transitions.push(t),
      onPosition: () => {},
    })

    void feeder.seek(6000) // seek#1 — will hang on its read, seekToken becomes 1
    await Promise.resolve()
    await feeder.seek(7000) // seek#2 — supersedes; seekToken becomes 2, lands 'playing'

    // Reconstruction, from the records alone: every line that ever named
    // seekToken 1 stopped at 'loading' — it never reached a terminal state —
    // while a STRICTLY NEWER token (2) reached 'playing'. That comparison
    // alone (no timestamps, no wall clock) proves token 1 is the one stuck,
    // and names its own last-known state.
    const token1Lines = transitions.filter((t) => t.seekToken === 1)
    expect(token1Lines).toEqual([
      {
        from: null,
        to: 'loading',
        reason: 'seek-start',
        seekToken: 1,
        dragId: undefined,
      },
    ])
    const latestToken = Math.max(...transitions.map((t) => t.seekToken))
    expect(latestToken).toBe(2)
    const latestTransition = transitions.filter((t) => t.seekToken === latestToken).at(-1)
    expect(latestTransition?.to).toBe('playing')
    feeder.dispose()
  })

  it('dragId rides the transition through a scrub commit', async () => {
    const transitions: FeederStateTransition[] = []
    const feeder = new RecordedFeeder({
      deviceId: 102,
      profile: 'low',
      locate: async ({ epochMs }) => ({
        kind: 'segment',
        startMs: Math.floor(epochMs / 1000) * 1000,
        durMs: 1000,
        bytes: 3,
      }),
      readGop: async ({ epochMs }) => ({
        gopStartMs: Math.floor(epochMs / 1000) * 1000,
        gopDurMs: 1000,
        bytes: new Uint8Array(1000),
      }),
      readBytes: async () => new Uint8Array(1000),
      demux: async () => [AU(0, true), AU(40)],
      sink: { pushAccessUnit: () => {} },
      onState: (t) => transitions.push(t),
      onPosition: () => {},
    })
    feeder.beginScrub('drag-Z')
    await feeder.seek(100_500, { dragId: 'drag-Z' })

    expect(transitions.length).toBeGreaterThan(0)
    for (const t of transitions) expect(t.dragId).toBe('drag-Z')
    feeder.dispose()
  })
})
