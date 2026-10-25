/**
 * Where each camera's last detection session ran (D916). The share election
 * keeps a camera on this node/device while it is within one session of the
 * turn holder, so a camera does not pay a stream dial, a decode-worker fork
 * and a cold pre-roll on every motion edge.
 *
 * In-memory and advisory, like the election memory it sits beside: it lives
 * as long as a decayed election counts (the same 30 minutes), and a restart
 * costs one fresh election per camera, never a wrong one.
 */
import { SHARE_HISTORY_HALF_LIFE_MS } from './share-election-history.js'

/** A remembered placement older than this is no placement at all. */
export const SESSION_AFFINITY_TTL_MS = SHARE_HISTORY_HALF_LIFE_MS

export interface RememberedPlacement {
  readonly nodeId: string
  /** The elected device, or null when the node's default pool served it. */
  readonly deviceKey: string | null
}

interface Entry extends RememberedPlacement {
  readonly at: number
}

export class SessionAffinityMemory {
  private readonly entries = new Map<number, Entry>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = SESSION_AFFINITY_TTL_MS,
  ) {}

  /** The camera's last placement, or null when none is remembered (or it expired). */
  previous(deviceId: number): RememberedPlacement | null {
    const entry = this.entries.get(deviceId)
    if (entry === undefined) return null
    if (this.now() - entry.at > this.ttlMs) {
      this.entries.delete(deviceId)
      return null
    }
    return { nodeId: entry.nodeId, deviceKey: entry.deviceKey }
  }

  /** Remember where the camera's session just attached. */
  note(deviceId: number, nodeId: string, deviceKey: string | null): void {
    this.entries.set(deviceId, { nodeId, deviceKey, at: this.now() })
  }

  /** Drop the camera's placement (its device refused the camera root). */
  forget(deviceId: number): void {
    this.entries.delete(deviceId)
  }
}
