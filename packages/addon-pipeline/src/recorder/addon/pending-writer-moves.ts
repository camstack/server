/**
 * The gap between the PLAN and the DISK, for as long as it stands.
 *
 * Placement applies at writer-attach boundaries only: the `.rec-tmp` staging
 * dir lives UNDER the chosen root so the finalize relocate is a
 * same-filesystem rename, and repointing a live writer would turn every
 * segment into the EXDEV copy+unlink fallback — 2× disk writes on the hot path
 * (the F1 regression). So a plan reaches a camera when it next attaches.
 *
 * For a camera on a schedule that is the next band edge, minutes away. For a
 * CONTINUOUSLY recording camera there is no next attach: its writer outlives
 * every tick, and its assignment can be re-planned onto a new disk forever
 * without one byte moving. That is the state this module makes visible (D387).
 * The alternative — detaching live writers to apply a plan — buys the move at
 * the cost of a recording gap on every affected camera at once, which is
 * exactly the wrong trade on the day an operator adds a disk to relieve
 * pressure.
 */
import path from 'node:path'
import type { CamProfile } from '@camstack/types'
import type { ActiveWriterDir } from './recording-controller.js'
import type { RecordingsLocation } from './roots.js'

/** One live writer whose planned location is not the one it is writing to. */
export interface PendingWriterMove {
  readonly deviceId: number
  readonly profile: CamProfile
  /** The location the writer's directory sits under. `null` ⇒ under no known root. */
  readonly writingTo: string | null
  readonly plannedFor: string
}

/** Is `dir` inside `root` (or the root itself)? A prefix compare that cannot
 *  match `/recordings-2` against `/recordings`. */
function isUnder(dir: string, root: string): boolean {
  const rel = path.relative(root, dir)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** The location whose root contains `dir` — the DEEPEST one, so a location
 *  nested inside another is attributed to the nested one. */
function locationOf(dir: string, locations: readonly RecordingsLocation[]): string | null {
  let best: RecordingsLocation | null = null
  for (const location of locations) {
    if (!isUnder(dir, location.root)) continue
    if (best === null || location.root.length > best.root.length) best = location
  }
  return best?.id ?? null
}

/**
 * Every live writer the plan wants somewhere else.
 *
 * A writer whose key the plan says nothing about is NOT pending: the pass
 * plans a work SUBSET, and "not in this pass" must never read as "planned
 * elsewhere". A writer under no known root is reported with `writingTo: null`
 * rather than dropped — a directory outside every resolved location is its own
 * fault, and a silent skip would hide it.
 */
export function pendingWriterMoves(
  writers: readonly ActiveWriterDir[],
  planned: ReadonlyMap<string, string>,
  locations: readonly RecordingsLocation[],
): readonly PendingWriterMove[] {
  const out: PendingWriterMove[] = []
  for (const writer of writers) {
    const plannedFor = planned.get(`${String(writer.deviceId)}:${writer.profile}`)
    if (plannedFor === undefined) continue
    const writingTo = locationOf(writer.outDir, locations)
    if (writingTo === plannedFor) continue
    out.push({ deviceId: writer.deviceId, profile: writer.profile, writingTo, plannedFor })
  }
  return out.toSorted((a, b) => a.deviceId - b.deviceId || a.profile.localeCompare(b.profile))
}

/** A stable signature of a pending set, so the report is latched on WHAT is
 *  pending rather than repeated every 30 s tick. */
export function pendingMovesSignature(moves: readonly PendingWriterMove[]): string {
  return moves.map((m) => `${String(m.deviceId)}:${m.profile}>${m.plannedFor}`).join(',')
}
