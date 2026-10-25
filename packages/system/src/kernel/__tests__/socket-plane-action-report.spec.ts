/**
 * The per-action census on the `[mem]` line (D456).
 *
 * D454 put the peer and the kind on the line and closed by naming what was
 * still missing: WHICH METHOD originates the 30–240 MB/min hub-main writes to
 * `pipeline-analytics`. It also recorded the constraint these tests exist to
 * protect — D446: the field prefixes are read by Loki, so the ORDER of the
 * fields that already exist may not change and a new one is appended LAST.
 *
 * And the coverage field is not decoration. After raw-forward 85.7 % of
 * sibling calls cross hub-main unread, so a census that named only what it
 * could label would present a confident attribution of whatever share it
 * happened to reach. `socketActions=<labelled>/<total>` is the census grading
 * itself, and it prints even at zero.
 */
import { describe, expect, it } from 'vitest'
import { createCapActionCensus, EMPTY_CAP_ACTION_READING } from '../transport/cap-action-census.js'
import {
  diffSocketPlane,
  EMPTY_SOCKET_PLANE_BASELINE,
  formatSocketPlane,
  type SocketPlaneCounters,
} from '../socket-plane-report.js'
import { EMPTY_SOCKET_DIRECTION } from '../transport/socket-traffic.js'

function counters(actions?: SocketPlaneCounters['actions']): SocketPlaneCounters {
  return {
    peers: [
      {
        peerId: 'pipeline-analytics',
        tx: { ...EMPTY_SOCKET_DIRECTION, resMessages: 1966, resBytes: 147_834_880 },
        rx: { ...EMPTY_SOCKET_DIRECTION, reqMessages: 1963, reqBytes: 7_837_696 },
        queuedBytes: 0,
      },
    ],
    peersConnected: 1,
    ...(actions === undefined ? {} : { actions }),
  }
}

describe('the action census on the line', () => {
  it('is absent entirely when the registry keeps none — never a zero', () => {
    const line = formatSocketPlane(diffSocketPlane(EMPTY_SOCKET_PLANE_BASELINE, counters()))
    expect(line).not.toContain('socketActions')
    expect(line).not.toContain('socketTopActions')
  })

  it('names the peer, the method, its bytes and its raw/decoded split', () => {
    const census = createCapActionCensus()
    census.record('pipeline-analytics', 'device-state.getAllSnapshots', 2_048, 139_264_000)
    for (let i = 0; i < 152; i += 1) {
      census.recordForward('pipeline-analytics', 'device-state.getAllSnapshots', 'decoded')
    }
    const line = formatSocketPlane(
      diffSocketPlane(EMPTY_SOCKET_PLANE_BASELINE, counters(census.read())),
    )
    expect(line).toContain('socketTopActions=pipeline-analytics!device-state.getAllSnapshots:')
    expect(line).toMatch(/device-state\.getAllSnapshots:\d+kB\/1:r0\/d152/)
  })

  it('grades its own coverage, and prints it even when it named nothing', () => {
    const census = createCapActionCensus()
    census.recordUnlabelled('pipeline-analytics', 4_096)
    const line = formatSocketPlane(
      diffSocketPlane(EMPTY_SOCKET_PLANE_BASELINE, counters(census.read())),
    )
    expect(line).toContain('socketActions=0/4kB')
    expect(line).not.toContain('socketTopActions=')
  })

  it('appends the new fields LAST, after socketFwd, so every Loki prefix still matches', () => {
    const census = createCapActionCensus()
    census.record('pipeline-analytics', 'a.b', 1, 100_000)
    const current: SocketPlaneCounters = {
      ...counters(census.read()),
      forward: { raw: 30_349, decoded: 5_051 },
    }
    const line = formatSocketPlane(diffSocketPlane(EMPTY_SOCKET_PLANE_BASELINE, current))
    const order = ['socketPeers=', 'socketTx=', 'socketRx=', 'socketQueued=', 'socketFwd=']
    let at = -1
    for (const field of order) {
      const next = line.indexOf(field)
      expect(next).toBeGreaterThan(at)
      at = next
    }
    expect(line.indexOf('socketActions=')).toBeGreaterThan(line.indexOf('socketFwd='))
    expect(line.indexOf('socketTopActions=')).toBeGreaterThan(line.indexOf('socketActions='))
  })

  it('ranks the named actions by BYTES, across peers', () => {
    const census = createCapActionCensus()
    for (let i = 0; i < 8_379; i += 1) census.record('broker', 'audio-codec.pullPcm', 40, 40)
    census.record('pipeline-analytics', 'device-state.getAllSnapshots', 10, 900_000)
    const line = formatSocketPlane(
      diffSocketPlane(EMPTY_SOCKET_PLANE_BASELINE, counters(census.read())),
    )
    const listed = line.split('socketTopActions=')[1] ?? ''
    expect(listed.indexOf('getAllSnapshots')).toBeLessThan(listed.indexOf('pullPcm'))
  })

  it('reports the WINDOW, not the total since boot', () => {
    const census = createCapActionCensus()
    census.record('pipeline-analytics', 'a.b', 0, 1_024_000)
    const first = diffSocketPlane(EMPTY_SOCKET_PLANE_BASELINE, counters(census.read()))
    expect(formatSocketPlane(first)).toContain('a.b:1000kB')

    const baseline = {
      peers: new Map(counters().peers.map((p) => [p.peerId, p])),
      actions: census.read(),
    }
    census.record('pipeline-analytics', 'a.b', 0, 2_048)
    const second = diffSocketPlane(baseline, counters(census.read()))
    expect(formatSocketPlane(second)).toContain('a.b:2kB')
  })

  it('starts from an empty reading without inventing a baseline', () => {
    const line = formatSocketPlane(
      diffSocketPlane(EMPTY_SOCKET_PLANE_BASELINE, counters(EMPTY_CAP_ACTION_READING)),
    )
    expect(line).toContain('socketActions=0/0kB')
  })
})
