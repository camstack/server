/**
 * The socket-plane report — attribution, not volume.
 *
 * "hub-main does 44 000 socket operations a second" was already known and
 * answered nothing. The question is *which peer, exchanging what kind of
 * message*, and the fixtures here are the measured shape of the answer: a
 * distribution that is NOT flat (one peer at 78–82 % of outbound bytes, the
 * runner-up at ~6 %) and a majority kind (`evt`) that scales with the number of
 * runners rather than with anything an operator asked for.
 *
 * Everything here is a DELTA. The channel counters are cumulative for the life
 * of the channel; a cumulative number on a heartbeat answers "how much since
 * boot", which nobody asked.
 */
import { describe, expect, it } from 'vitest'
import {
  createSocketPlaneMeter,
  createSocketPlaneReader,
  diffSocketPlane,
  EMPTY_SOCKET_PLANE_BASELINE,
  formatSocketPlane,
  SOCKET_PLANE_TOP_N,
  type SocketPlaneCounters,
  type SocketPlaneRegistry,
} from '../socket-plane-report.js'
import {
  EMPTY_SOCKET_DIRECTION,
  type SocketDirectionSample,
  type SocketTrafficSample,
} from '../transport/socket-traffic.js'

function dir(over: Partial<SocketDirectionSample>): SocketDirectionSample {
  return { ...EMPTY_SOCKET_DIRECTION, ...over }
}

function traffic(tx: SocketDirectionSample, rx: SocketDirectionSample): SocketTrafficSample {
  return { tx, rx }
}

/** A registry with a fixed set of children and whatever counters the test gives. */
function registryOf(
  entries: ReadonlyMap<string, SocketTrafficSample | null>,
  queued: ReadonlyMap<string, number | null> = new Map(),
): SocketPlaneRegistry {
  return {
    listChildren: () => [...entries.keys()].map((childId) => ({ childId })),
    getChildSocketTraffic: (childId) => entries.get(childId) ?? null,
    getChildQueuedBytes: (childId) => queued.get(childId) ?? null,
  }
}

describe('the outbound queue is read per peer, live, and unknown is never zero (D446)', () => {
  const MB = 1048576
  const measured = traffic(dir({ evtMessages: 1 }), EMPTY_SOCKET_DIRECTION)

  it('the reader carries each peer queue depth, and a channel with no reading is null', () => {
    const read = createSocketPlaneReader({
      registry: () =>
        registryOf(
          new Map([
            ['pipeline-orchestrator', measured],
            ['recorder', measured],
            ['legacy', measured],
          ]),
          new Map([
            ['pipeline-orchestrator', 300 * MB],
            ['recorder', 0],
          ]),
        ),
    })
    const counters = read()
    expect(counters?.peers.map((p) => [p.peerId, p.queuedBytes])).toEqual([
      ['pipeline-orchestrator', 300 * MB],
      ['recorder', 0],
      ['legacy', null],
    ])
  })

  it('the window totals the queue, names the peers holding one largest first, and counts the unmeasured', () => {
    const counters: SocketPlaneCounters = {
      peersConnected: 4,
      peers: [
        { queuedBytes: 2 * MB, peerId: 'recorder', tx: dir({}), rx: dir({}) },
        { queuedBytes: 300 * MB, peerId: 'pipeline-orchestrator', tx: dir({}), rx: dir({}) },
        { queuedBytes: 0, peerId: 'ml', tx: dir({}), rx: dir({}) },
        { queuedBytes: null, peerId: 'legacy', tx: dir({}), rx: dir({}) },
      ],
    }
    const window = diffSocketPlane(EMPTY_SOCKET_PLANE_BASELINE, counters)
    expect(window.queued.totalBytes).toBe(302 * MB)
    expect(window.queued.unmeasured).toBe(1)
    expect(window.queued.top.map((p) => p.peerId)).toEqual(['pipeline-orchestrator', 'recorder'])
    const line = formatSocketPlane(window)
    expect(line).toContain(' socketQueued=309248kB')
    expect(line).toContain(' socketQueuedUnmeasured=1')
    expect(line).toContain(' socketQueuedTop=pipeline-orchestrator:307200,recorder:2048')
  })

  it('a quiet plane prints the total at zero and neither the ranking nor the unmeasured count', () => {
    const counters: SocketPlaneCounters = {
      peersConnected: 1,
      peers: [{ queuedBytes: 0, peerId: 'ml', tx: dir({}), rx: dir({}) }],
    }
    const line = formatSocketPlane(diffSocketPlane(EMPTY_SOCKET_PLANE_BASELINE, counters))
    expect(line).toContain(' socketQueued=0kB')
    expect(line).not.toContain('socketQueuedTop=')
    expect(line).not.toContain('socketQueuedUnmeasured=')
  })
})

describe('the reader distinguishes "no plane", "unmeasured" and "silent"', () => {
  it('reports undefined until the registry exists — a plane that does not exist is not a quiet one', () => {
    const read = createSocketPlaneReader({ registry: () => null })
    expect(read()).toBeUndefined()
  })

  it('a channel that keeps no counters is UNMEASURED, and the gap is visible', () => {
    const read = createSocketPlaneReader({
      registry: () =>
        registryOf(
          new Map([
            ['hub/recorder', traffic(dir({ evtMessages: 3 }), EMPTY_SOCKET_DIRECTION)],
            ['hub/legacy', null],
          ]),
        ),
    })
    const counters = read()
    expect(counters).toBeDefined()
    if (counters === undefined) return
    expect(counters.peersConnected).toBe(2)
    expect(counters.peers).toHaveLength(1)
    // `socketPeers=1/2` is the only way an operator ever learns that one link
    // is not being counted. A reader that silently dropped it would report a
    // total that looks complete and is not.
    expect(formatSocketPlane(diffSocketPlane(EMPTY_SOCKET_PLANE_BASELINE, counters))).toContain(
      'socketPeers=1/2',
    )
  })

  it('never throws out of a registry mid-teardown', () => {
    const read = createSocketPlaneReader({
      registry: () => {
        throw new Error('registry is gone')
      },
    })
    expect(read()).toBeUndefined()
  })
})

describe('the window is a delta against the previous LINE', () => {
  const first: SocketPlaneCounters = {
    peersConnected: 1,
    peers: [
      {
        queuedBytes: 0,
        peerId: 'hub/pipeline-analytics',
        tx: dir({ reqMessages: 100, reqBytes: 40_000, evtMessages: 900, evtBytes: 300_000 }),
        rx: dir({ resMessages: 100, resBytes: 41_000 }),
      },
    ],
  }
  const second: SocketPlaneCounters = {
    peersConnected: 1,
    peers: [
      {
        queuedBytes: 0,
        peerId: 'hub/pipeline-analytics',
        tx: dir({ reqMessages: 160, reqBytes: 64_000, evtMessages: 1400, evtBytes: 460_000 }),
        rx: dir({ resMessages: 160, resBytes: 65_600 }),
      },
    ],
  }

  it('the first read is the whole history, the second is only the window', () => {
    const meter = createSocketPlaneMeter(() => first)
    expect(meter.read()?.tx.evtMessages).toBe(900)

    let current = first
    const rolling = createSocketPlaneMeter(() => current)
    rolling.read()
    current = second
    const window = rolling.read()
    expect(window?.tx.reqMessages).toBe(60)
    expect(window?.tx.evtMessages).toBe(500)
    expect(window?.rx.resMessages).toBe(60)
  })

  it('a RESPAWNED peer reads as a quiet window, never as a negative rate', () => {
    // Same childId, fresh channel, counters back at zero. A negative number on
    // a rate reads as a broken meter; the window's traffic is genuinely unknown.
    const after: SocketPlaneCounters = {
      peersConnected: 1,
      peers: [
        {
          queuedBytes: 0,
          peerId: 'hub/pipeline-analytics',
          tx: dir({ evtMessages: 4 }),
          rx: dir({}),
        },
      ],
    }
    const window = diffSocketPlane(
      { peers: new Map(second.peers.map((p) => [p.peerId, p])) },
      after,
    )
    // Every field clamps to 0: the four events the new channel has seen are
    // NOT the window's traffic, and reporting them as if they were would
    // under-report a restart as a 99.7% drop in rate.
    expect(window.tx.evtMessages).toBe(0)
    expect(window.tx.reqMessages).toBe(0)
    expect(window.tx.evtBytes).toBe(0)
    // The next window then measures normally, from the new baseline.
    const next = diffSocketPlane(
      { peers: new Map(after.peers.map((p) => [p.peerId, p])) },
      {
        peersConnected: 1,
        peers: [
          {
            queuedBytes: 0,
            peerId: 'hub/pipeline-analytics',
            tx: dir({ evtMessages: 9 }),
            rx: dir({}),
          },
        ],
      },
    )
    expect(next.tx.evtMessages).toBe(5)
  })
})

describe('the ranking names the peer that dominates', () => {
  const busy: SocketPlaneCounters = {
    peersConnected: 4,
    peers: [
      { queuedBytes: 0, peerId: 'hub/ml', tx: dir({ evtMessages: 82 }), rx: dir({}) },
      {
        queuedBytes: 0,
        peerId: 'hub/pipeline-analytics',
        tx: dir({ evtMessages: 5000, evtBytes: 2_048_000 }),
        rx: dir({ reqMessages: 794, reqBytes: 262_144 }),
      },
      { queuedBytes: 0, peerId: 'hub/decoder-ffmpeg', tx: dir({ evtMessages: 300 }), rx: dir({}) },
      { queuedBytes: 0, peerId: 'hub/idle', tx: dir({}), rx: dir({}) },
    ],
  }

  it('sorts by total messages, both directions, busiest first', () => {
    const window = diffSocketPlane(EMPTY_SOCKET_PLANE_BASELINE, busy)
    expect(window.top.map((p) => p.peerId)).toEqual([
      'hub/pipeline-analytics',
      'hub/decoder-ffmpeg',
      'hub/ml',
    ])
    // A peer that moved nothing is not ranked — a list of zeros is noise.
    expect(window.top.some((p) => p.peerId === 'hub/idle')).toBe(false)
  })

  it('names at most five, because a 38-peer line stops being read', () => {
    const many: SocketPlaneCounters = {
      peersConnected: 38,
      peers: Array.from({ length: 38 }, (_v, i) => ({
        queuedBytes: 0,
        peerId: `runner-${String(i).padStart(2, '0')}`,
        tx: dir({ evtMessages: 100 - i }),
        rx: dir({}),
      })),
    }
    const window = diffSocketPlane(EMPTY_SOCKET_PLANE_BASELINE, many)
    expect(SOCKET_PLANE_TOP_N).toBe(5)
    expect(window.top).toHaveLength(5)
    expect(window.top[0]?.peerId).toBe('runner-00')
  })

  it('the totals cover EVERY measured peer, not only the five that are named', () => {
    const window = diffSocketPlane(EMPTY_SOCKET_PLANE_BASELINE, busy)
    expect(window.tx.evtMessages).toBe(82 + 5000 + 300)
    expect(window.rx.reqMessages).toBe(794)
  })
})

describe('the line says which peer, and which kind', () => {
  const busy: SocketPlaneCounters = {
    peersConnected: 2,
    peers: [
      {
        queuedBytes: 0,
        peerId: 'hub/pipeline-analytics',
        tx: dir({ evtMessages: 5000, evtBytes: 2_048_000, reqMessages: 12, reqBytes: 4096 }),
        rx: dir({ resMessages: 12, resBytes: 8192 }),
      },
      {
        queuedBytes: 0,
        peerId: 'hub/ml',
        tx: dir({ evtMessages: 82, evtBytes: 27_136 }),
        rx: dir({}),
      },
    ],
  }

  it('prints every kind in both directions, including at zero', () => {
    const line = formatSocketPlane(diffSocketPlane(EMPTY_SOCKET_PLANE_BASELINE, busy))
    expect(line).toContain(' socketTx=req:12/4kB,res:0/0kB,evt:5082/2027kB')
    expect(line).toContain(' socketRx=req:0/0kB,res:12/8kB,evt:0/0kB')
  })

  it('the top entry carries the whole peer×kind cross for that peer', () => {
    const line = formatSocketPlane(diffSocketPlane(EMPTY_SOCKET_PLANE_BASELINE, busy))
    // tx=req/res/evt : rx=… : txkB=req/res/evt : rxkB=… — the question in one
    // token. The bytes were a per-direction TOTAL until D454; a total cannot
    // say whether a peer's bytes were responses or fan-out, which is the one
    // thing this instrument exists to settle.
    expect(line).toContain(
      'socketTop=hub/pipeline-analytics:tx=12/0/5000:rx=0/12/0:txkB=4/0/2000:rxkB=0/8/0',
    )
    expect(line).toContain('hub/ml:tx=0/0/82:rx=0/0/0:txkB=0/0/27:rxkB=0/0/0')
  })

  it('a plane with no traffic prints the fields and omits only the ranking', () => {
    const quiet: SocketPlaneCounters = {
      peersConnected: 3,
      peers: [{ queuedBytes: 0, peerId: 'hub/ml', tx: dir({}), rx: dir({}) }],
    }
    const line = formatSocketPlane(diffSocketPlane(EMPTY_SOCKET_PLANE_BASELINE, quiet))
    expect(line).toContain('socketPeers=1/3')
    expect(line).toContain('socketTx=req:0/0kB,res:0/0kB,evt:0/0kB')
    // A ranked list of nothing is noise; the field COUNT staying stable
    // otherwise is what keeps the line parseable.
    expect(line).not.toContain('socketTop=')
  })

  it('a process with no plane contributes nothing at all to the line', () => {
    expect(formatSocketPlane(undefined)).toBe('')
  })
})

/**
 * D454. The message ranking cannot see a peer that moves FEW, HUGE frames, and
 * the per-peer `kB=tx/rx` total cannot say whether those bytes were responses
 * or fan-out. Both gaps were paid for on 2026-09-11: over 56 consecutive
 * heartbeat windows hub-main wrote 15–376 MB/min to `hub/pipeline-analytics`
 * while its message counts barely moved, and the five peers the line named by
 * MESSAGES left 116 MB/min of outbound bytes with no name on them at all.
 */
describe('a peer that moves few bytes-heavy frames is named, and its bytes say which kind', () => {
  /** Few messages, enormous payloads — invisible to a message ranking. */
  const whale: SocketPlaneCounters = {
    peersConnected: 4,
    peers: [
      {
        queuedBytes: 0,
        peerId: 'hub/chatty',
        tx: dir({ evtMessages: 20_000, evtBytes: 1_024_000 }),
        rx: dir({}),
      },
      {
        queuedBytes: 0,
        peerId: 'hub/pipeline-analytics',
        tx: dir({
          resMessages: 1895,
          resBytes: 100_663_296,
          evtMessages: 6612,
          evtBytes: 5_570_560,
        }),
        rx: dir({ reqMessages: 1897, reqBytes: 2_025_472 }),
      },
      {
        queuedBytes: 0,
        peerId: 'hub/busy-a',
        tx: dir({ evtMessages: 19_000, evtBytes: 512_000 }),
        rx: dir({}),
      },
      {
        queuedBytes: 0,
        peerId: 'hub/busy-b',
        tx: dir({ evtMessages: 18_000, evtBytes: 256_000 }),
        rx: dir({}),
      },
    ],
  }

  it('ranks a second list by BYTES, both directions, heaviest first', () => {
    const window = diffSocketPlane(EMPTY_SOCKET_PLANE_BASELINE, whale, 2)
    expect(window.topBytes.map((p) => p.peerId)).toEqual(['hub/pipeline-analytics', 'hub/chatty'])
  })

  it('names the byte whale even when the message ranking has no room for it', () => {
    const window = diffSocketPlane(EMPTY_SOCKET_PLANE_BASELINE, whale, 2)
    // Ranked by messages the whale is last of four and never printed.
    expect(window.top.map((p) => p.peerId)).toEqual(['hub/chatty', 'hub/busy-a'])
    expect(window.topBytes[0]?.peerId).toBe('hub/pipeline-analytics')
  })

  it('prints socketTopBytes ONLY when it names a peer socketTop does not', () => {
    const hidden = formatSocketPlane(diffSocketPlane(EMPTY_SOCKET_PLANE_BASELINE, whale, 2))
    expect(hidden).toContain('socketTopBytes=hub/pipeline-analytics:')
    // Room for everyone: the byte list adds no name, so it is not printed.
    const roomy = formatSocketPlane(diffSocketPlane(EMPTY_SOCKET_PLANE_BASELINE, whale, 5))
    expect(roomy).toContain('socketTop=')
    expect(roomy).not.toContain('socketTopBytes=')
  })

  it('splits a peer BYTES by kind, so res and evt are never summed into one number', () => {
    const line = formatSocketPlane(diffSocketPlane(EMPTY_SOCKET_PLANE_BASELINE, whale, 5))
    // txkB / rxkB carry req/res/evt in the same order as the message triples.
    expect(line).toContain(
      'hub/pipeline-analytics:tx=0/1895/6612:rx=1897/0/0:txkB=0/98304/5440:rxkB=1978/0/0',
    )
  })
})
