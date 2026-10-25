/**
 * What session placement actually did (D748) — the "actual" column next to
 * each share slider. In memory on the hub, fed by the session dispatcher:
 *
 *  - every change of the running-session set (`noteSessions`) closes the
 *    previous segment, so a share is TIME-WEIGHTED over parallel sessions —
 *    the quantity a share holds — not a count of elections;
 *  - every start (`noteStart`) and every share-election yield
 *    (`noteYield`) is stamped for the per-window counters.
 *
 * Bounded: anything older than 24 h is dropped. A hub restart starts a new
 * window, and the snapshot says how much of the window it actually covers.
 */
import type { PlacementDeviceStats, PlacementNodeStats } from '@camstack/types'

const RETAIN_MS = 24 * 60 * 60 * 1000

export interface RunningSession {
  readonly nodeId: string
  /** `''` = the node's default pool. */
  readonly deviceKey: string
}

interface Segment {
  readonly at: number
  /** `node\0device` → running sessions from `at` until the next segment. */
  readonly counts: ReadonlyMap<string, number>
}

interface Stamp {
  readonly at: number
  readonly nodeId: string
  readonly deviceKey: string
}

export interface PlacementStatsSnapshot {
  readonly observedForMs: number
  readonly sessionsNow: number
  readonly clusterPeakSessions: number
  readonly nodes: readonly PlacementNodeStats[]
}

function keyOf(nodeId: string, deviceKey: string): string {
  return `${nodeId}\u0000${deviceKey}`
}

function split(key: string): RunningSession {
  const [nodeId = '', deviceKey = ''] = key.split('\u0000')
  return { nodeId, deviceKey }
}

export class SessionPlacementStats {
  private readonly segments: Segment[] = []
  private readonly starts: Stamp[] = []
  private readonly yields: { readonly at: number; readonly nodeId: string }[] = []
  private readonly startedAt: number

  constructor(private readonly now: () => number = () => Date.now()) {
    this.startedAt = now()
  }

  /** The running-session set changed: open a new segment with these counts. */
  noteSessions(sessions: readonly RunningSession[]): void {
    const counts = new Map<string, number>()
    for (const s of sessions) {
      const k = keyOf(s.nodeId, s.deviceKey)
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    this.segments.push({ at: this.now(), counts })
    this.prune()
  }

  noteStart(nodeId: string, deviceKey: string): void {
    this.starts.push({ at: this.now(), nodeId, deviceKey })
    this.prune()
  }

  /** A share election handed `nodeId`'s turn to another node. */
  noteYield(nodeId: string): void {
    this.yields.push({ at: this.now(), nodeId })
    this.prune()
  }

  /** For tests: how many segments are retained. */
  segmentCount(): number {
    return this.segments.length
  }

  private prune(): void {
    const floor = this.now() - RETAIN_MS
    // Keep the last segment that STARTED before the floor: it still covers it.
    while (this.segments.length > 1 && this.segments[1]!.at <= floor) this.segments.shift()
    while (this.starts.length > 0 && this.starts[0]!.at < floor) this.starts.shift()
    while (this.yields.length > 0 && this.yields[0]!.at < floor) this.yields.shift()
  }

  snapshot(windowMs: number): PlacementStatsSnapshot {
    const now = this.now()
    const from = now - windowMs
    // session-ms per key, and the cluster peak, over [from, now].
    const integral = new Map<string, number>()
    let clusterPeak = 0
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i]!
      const end = this.segments[i + 1]?.at ?? now
      const start = Math.max(seg.at, from)
      if (end <= start) continue
      let total = 0
      for (const [k, n] of seg.counts) {
        integral.set(k, (integral.get(k) ?? 0) + n * (end - start))
        total += n
      }
      clusterPeak = Math.max(clusterPeak, total)
    }
    const current = this.segments.at(-1)?.counts ?? new Map<string, number>()

    const nodeIds = new Set<string>()
    for (const k of [...integral.keys(), ...current.keys()]) nodeIds.add(split(k).nodeId)
    for (const s of this.starts) if (s.at >= from) nodeIds.add(s.nodeId)

    const clusterIntegral = [...integral.values()].reduce((a, b) => a + b, 0)
    const nodes = [...nodeIds].toSorted().map((nodeId): PlacementNodeStats => {
      const deviceKeys = new Set<string>()
      for (const k of [...integral.keys(), ...current.keys()]) {
        const s = split(k)
        if (s.nodeId === nodeId) deviceKeys.add(s.deviceKey)
      }
      for (const s of this.starts)
        if (s.at >= from && s.nodeId === nodeId) deviceKeys.add(s.deviceKey)
      const nodeIntegral = [...deviceKeys].reduce(
        (sum, d) => sum + (integral.get(keyOf(nodeId, d)) ?? 0),
        0,
      )
      const devices = [...deviceKeys].toSorted().map(
        (deviceKey): PlacementDeviceStats => ({
          deviceKey,
          sessionsNow: current.get(keyOf(nodeId, deviceKey)) ?? 0,
          sessionsStarted: this.starts.filter(
            (s) => s.at >= from && s.nodeId === nodeId && s.deviceKey === deviceKey,
          ).length,
          observedShare:
            nodeIntegral > 0 ? (integral.get(keyOf(nodeId, deviceKey)) ?? 0) / nodeIntegral : null,
        }),
      )
      let peak = 0
      for (let i = 0; i < this.segments.length; i++) {
        const seg = this.segments[i]!
        const end = this.segments[i + 1]?.at ?? now
        if (end <= Math.max(seg.at, from)) continue
        let n = 0
        for (const [k, c] of seg.counts) if (split(k).nodeId === nodeId) n += c
        peak = Math.max(peak, n)
      }
      return {
        nodeId,
        sessionsNow: devices.reduce((s, d) => s + d.sessionsNow, 0),
        sessionsStarted: devices.reduce((s, d) => s + d.sessionsStarted, 0),
        observedShare:
          clusterIntegral > 0 && nodeIntegral > 0 ? nodeIntegral / clusterIntegral : null,
        peakSessions: peak,
        yieldsAway: this.yields.filter((y) => y.at >= from && y.nodeId === nodeId).length,
        devices,
      }
    })
    return {
      observedForMs: Math.min(windowMs, now - this.startedAt),
      sessionsNow: [...current.values()].reduce((a, b) => a + b, 0),
      clusterPeakSessions: clusterPeak,
      nodes,
    }
  }
}
