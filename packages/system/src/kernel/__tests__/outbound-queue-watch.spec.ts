/**
 * An outbound queue that grows for a minute is named, and its release is
 * timestamped (D446).
 *
 * The 2026-09-10 episodes — 4 968 MB of ArrayBuffers climbing at a constant
 * 63 MB/min for 77 minutes and released in one instant — had no owner and no
 * line. Every socket write queue in this process was excluded by
 * `_getActiveHandles()`, which does not list an UNREF'D handle, and Moleculer's
 * `TcpWriter` unrefs every socket it opens. This gate judges the queue depth
 * of every outbound channel the heartbeat can reach, whatever its ref state.
 *
 * Disarms:
 *  - delete the sustain check → "a burst that drains inside the window" red;
 *  - delete the cooldown → "warns once per cooldown" red;
 *  - delete the release branch → "the release is a verdict" red.
 */
import { describe, expect, it } from 'vitest'
import {
  createOutboundQueueGate,
  formatOutboundQueueVerdict,
  OUTBOUND_QUEUE_COOLDOWN_MS,
  OUTBOUND_QUEUE_SUSTAIN_MS,
  OUTBOUND_QUEUE_THRESHOLD_BYTES,
  type OutboundQueueVerdict,
} from '../outbound-queue-watch.js'

const MB = 1048576
const STEP = 2000

function kinds(verdicts: readonly OutboundQueueVerdict[]): readonly string[] {
  return verdicts.map((v) => `${v.kind}:${v.peerId}`)
}

describe('a queue held above the bound for the sustain window is named once', () => {
  it('says nothing below the threshold, and nothing before the sustain window', () => {
    const gate = createOutboundQueueGate()
    let at = 0
    expect(gate.observe([{ peerId: 'uds:pipeline-orchestrator', bytes: 4 * MB }], at)).toEqual([])
    for (; at < OUTBOUND_QUEUE_SUSTAIN_MS - STEP; at += STEP) {
      expect(
        gate.observe(
          [{ peerId: 'uds:pipeline-orchestrator', bytes: OUTBOUND_QUEUE_THRESHOLD_BYTES + MB }],
          at,
        ),
      ).toEqual([])
    }
  })

  it('a burst that drains inside the window is never named', () => {
    const gate = createOutboundQueueGate()
    gate.observe([{ peerId: 'mesh:agent-a', bytes: 200 * MB }], 0)
    gate.observe([{ peerId: 'mesh:agent-a', bytes: 200 * MB }], STEP)
    expect(gate.observe([{ peerId: 'mesh:agent-a', bytes: 0 }], 2 * STEP)).toEqual([])
    // ...and a fresh climb starts its own window from scratch.
    expect(
      gate.observe([{ peerId: 'mesh:agent-a', bytes: 200 * MB }], OUTBOUND_QUEUE_SUSTAIN_MS),
    ).toEqual([])
  })

  it('warns once the hold reaches the sustain window, with the peak and the hold', () => {
    const gate = createOutboundQueueGate()
    let at = 0
    for (; at < OUTBOUND_QUEUE_SUSTAIN_MS; at += STEP) {
      gate.observe([{ peerId: 'mesh:agent-a', bytes: (100 + at / 1000) * MB }], at)
    }
    const verdicts = gate.observe([{ peerId: 'mesh:agent-a', bytes: 170 * MB }], at)
    expect(kinds(verdicts)).toEqual(['sustained:mesh:agent-a'])
    const v = verdicts[0]
    if (v?.kind !== 'sustained') throw new Error('expected a sustained verdict')
    expect(v.bytes).toBe(170 * MB)
    expect(v.peakBytes).toBe(170 * MB)
    expect(v.heldForMs).toBe(OUTBOUND_QUEUE_SUSTAIN_MS)
  })

  it('warns once per cooldown, not once per probe', () => {
    const gate = createOutboundQueueGate()
    const reading = [{ peerId: 'uds:pipeline-analytics', bytes: 500 * MB }]
    let named = 0
    for (let at = 0; at <= OUTBOUND_QUEUE_COOLDOWN_MS + OUTBOUND_QUEUE_SUSTAIN_MS; at += STEP) {
      named += gate.observe(reading, at).filter((v) => v.kind === 'sustained').length
    }
    expect(named).toBe(2)
  })

  it('judges every peer on its own', () => {
    const gate = createOutboundQueueGate()
    let at = 0
    for (; at < OUTBOUND_QUEUE_SUSTAIN_MS; at += STEP) {
      gate.observe(
        [
          { peerId: 'uds:pipeline-orchestrator', bytes: 90 * MB },
          { peerId: 'uds:recorder', bytes: 1 * MB },
        ],
        at,
      )
    }
    const verdicts = gate.observe(
      [
        { peerId: 'uds:pipeline-orchestrator', bytes: 90 * MB },
        { peerId: 'uds:recorder', bytes: 1 * MB },
      ],
      at,
    )
    expect(kinds(verdicts)).toEqual(['sustained:uds:pipeline-orchestrator'])
  })
})

describe('the release is a verdict, because the episodes had none', () => {
  function held(gate: ReturnType<typeof createOutboundQueueGate>, peerId: string): number {
    let at = 0
    for (; at <= OUTBOUND_QUEUE_SUSTAIN_MS; at += STEP) {
      gate.observe([{ peerId, bytes: 800 * MB }], at)
    }
    return at
  }

  it('a sustained queue that drops under half the bound is reported with its peak and hold', () => {
    const gate = createOutboundQueueGate()
    const at = held(gate, 'mesh:MacMiniAgent.localdomain')
    const verdicts = gate.observe([{ peerId: 'mesh:MacMiniAgent.localdomain', bytes: 2 * MB }], at)
    expect(kinds(verdicts)).toEqual(['released:mesh:MacMiniAgent.localdomain'])
    const v = verdicts[0]
    if (v?.kind !== 'released') throw new Error('expected a released verdict')
    expect(v.peakBytes).toBe(800 * MB)
    expect(v.toBytes).toBe(2 * MB)
    expect(v.heldForMs).toBe(at)
  })

  it('a sustained peer that VANISHES from the readings is a release too — a socket that died is how a queue is dropped', () => {
    const gate = createOutboundQueueGate()
    const at = held(gate, 'uds:pipeline-orchestrator')
    const verdicts = gate.observe([], at)
    expect(kinds(verdicts)).toEqual(['released:uds:pipeline-orchestrator'])
    const v = verdicts[0]
    if (v?.kind !== 'released') throw new Error('expected a released verdict')
    expect(v.toBytes).toBe(0)
    expect(v.gone).toBe(true)
  })

  it('after a release the next climb is judged from scratch', () => {
    const gate = createOutboundQueueGate()
    const at = held(gate, 'uds:pipeline-orchestrator')
    gate.observe([{ peerId: 'uds:pipeline-orchestrator', bytes: 0 }], at)
    expect(
      gate.observe([{ peerId: 'uds:pipeline-orchestrator', bytes: 800 * MB }], at + STEP),
    ).toEqual([])
  })
})

describe('the line names the peer, the bytes and the duration', () => {
  it('sustained', () => {
    const line = formatOutboundQueueVerdict('hub-main', {
      kind: 'sustained',
      peerId: 'mesh:agent-a',
      bytes: 170 * MB,
      peakBytes: 170 * MB,
      heldForMs: 60_000,
    })
    expect(line).toContain('[mem] hub-main outbound queue to mesh:agent-a')
    expect(line).toContain('170MB')
    expect(line).toContain('60s')
    expect(line).toContain('_getActiveHandles')
  })

  it('released', () => {
    const line = formatOutboundQueueVerdict('hub-main', {
      kind: 'released',
      peerId: 'uds:pipeline-orchestrator',
      peakBytes: 4968 * MB,
      toBytes: 0,
      heldForMs: 77 * 60_000,
      gone: true,
    })
    expect(line).toContain('RELEASED')
    expect(line).toContain('4968MB')
    expect(line).toContain('77m')
    expect(line).toContain('peer gone')
  })
})
