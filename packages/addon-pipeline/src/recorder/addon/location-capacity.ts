/**
 * Volume capacity for one recordings location root.
 *
 * `statfs` is the only thing in `recording.getStorageUsage` that can answer
 * "is the disk full?" — the indexed byte total answers "how much of it is
 * footage", which is a different question and a much smaller number on a
 * shared array.
 *
 * The failure is modelled, not swallowed. A recordings root on a network share
 * that stops responding returns nulls, and the reason travels back with them so
 * the caller can log it against the location: a bare `catch {}` here made a dead
 * NAS and a filesystem with no capacity notion produce byte-identical payloads
 * and not one log line.
 */

/** Free/total bytes on a location's volume, or why they are unknown. */
export interface LocationCapacity {
  readonly availableBytes: number | null
  readonly totalBytes: number | null
  /** Why capacity is unknown. Absent when the volume answered. */
  readonly error?: string
}

/** The three `statfs` fields capacity is derived from (`node:fs` StatsFs). */
export interface StatfsResult {
  readonly bsize: number
  readonly bavail: number
  readonly blocks: number
}

export type StatfsFn = (root: string) => Promise<StatfsResult>

/** Human-readable failure text for a thrown value of unknown shape. */
function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Free + total bytes on the volume backing `root`.
 *
 * Never throws: an unreachable volume is one degraded ROW, not a failed
 * `getStorageUsage` — a NAS that stops answering must not blank the capacity of
 * every other disk on the node.
 */
export async function readLocationCapacity(
  root: string,
  statfs: StatfsFn,
): Promise<LocationCapacity> {
  try {
    const st = await statfs(root)
    return { availableBytes: st.bavail * st.bsize, totalBytes: st.blocks * st.bsize }
  } catch (err: unknown) {
    return { availableBytes: null, totalBytes: null, error: reasonOf(err) }
  }
}
