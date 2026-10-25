/**
 * A read that FAILED, or whose provider is not registered yet, is not an
 * answer — and an answer that contradicts what was exported is not believed
 * on its own either (D49, D315, D393).
 *
 * `ReadMirror` keeps, per device and per part of its component set (bound
 * caps, zones, streams, presets, function switches), the last set that was
 * exported. The export derives from `resolve(...)`, never from the raw read:
 *
 *  - an ANSWERED read that only adds or relabels is applied at once;
 *  - an ANSWERED read that DROPS something is applied only when the next
 *    answered read drops the same things (two consecutive answers agreeing);
 *  - a FAILED read changes nothing: the held set is exported again;
 *  - a failed read with nothing held is `unknown` — the caller must not
 *    announce the device at all, because an empty set would delete entities.
 *
 * The incident this closes: a hub boot raced the `webrtc-session`
 * provider, every camera's stream read failed, 79 entities became 51 and Home
 * Assistant removed the missing ones.
 */
import type { CameraFunctionReads } from './camera-functions.js'

export type ReadOutcome<T> =
  | { readonly kind: 'answered'; readonly items: readonly T[] }
  | { readonly kind: 'failed'; readonly reason: string }

export type MirrorResolution<T> =
  | { readonly status: 'fresh'; readonly items: readonly T[] }
  | {
      readonly status: 'held-failed'
      readonly items: readonly T[]
      readonly reason: string
    }
  | {
      readonly status: 'held-removal'
      readonly items: readonly T[]
      readonly reason: string
    }
  | { readonly status: 'unknown'; readonly reason: string }

interface Entry<T> {
  confirmed: readonly T[]
  /** Keys the previous answered read dropped, awaiting a second vote. */
  pendingDrop: string | null
}

export class ReadMirror<T> {
  private readonly entries = new Map<number, Entry<T>>()

  constructor(private readonly keyOf: (item: T) => string) {}

  resolve(deviceId: number, outcome: ReadOutcome<T>): MirrorResolution<T> {
    const entry = this.entries.get(deviceId)

    if (outcome.kind === 'failed') {
      if (entry === undefined) return { status: 'unknown', reason: outcome.reason }
      return {
        status: 'held-failed',
        items: entry.confirmed,
        reason: outcome.reason,
      }
    }

    if (entry === undefined) {
      this.entries.set(deviceId, {
        confirmed: outcome.items,
        pendingDrop: null,
      })
      return { status: 'fresh', items: outcome.items }
    }

    const incoming = new Set(outcome.items.map(this.keyOf))
    const dropped = entry.confirmed
      .map(this.keyOf)
      .filter((key) => !incoming.has(key))
      .toSorted()
    if (dropped.length === 0) {
      entry.confirmed = outcome.items
      entry.pendingDrop = null
      return { status: 'fresh', items: outcome.items }
    }

    const vote = dropped.join('\u0000')
    if (entry.pendingDrop === vote) {
      entry.confirmed = outcome.items
      entry.pendingDrop = null
      return { status: 'fresh', items: outcome.items }
    }
    entry.pendingDrop = vote
    return {
      status: 'held-removal',
      items: entry.confirmed,
      reason: `an answered read dropped ${dropped.join(', ')}; waiting for a second answer to agree`,
    }
  }
}

/**
 * The async sources `readCameraFunctions` could not obtain, or `null` when
 * every one answered. Their absence turns a function switch into "not
 * available", which removes its entity — a failure must not look like that.
 * `brokerAudioMuted` is only a read at all when the camera has a source node,
 * and `privacy` is a snapshot slice (absent = the cap is not there).
 */
export function cameraFunctionReadsFailed(
  reads: CameraFunctionReads,
  sourceNodeId: string | null,
): string | null {
  const failed: string[] = []
  if (reads.bindableCapNames === null) failed.push('bindableCapNames')
  if (reads.wrappedCapNames === null) failed.push('wrappedCapNames')
  if (reads.recordingEnabled === null) failed.push('recordingEnabled')
  if (reads.notificationsMuted === null) failed.push('notificationsMuted')
  if (sourceNodeId !== null && reads.brokerAudioMuted === null) failed.push('brokerAudioMuted')
  return failed.length === 0 ? null : `did not answer: ${failed.join(', ')}`
}
