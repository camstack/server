/**
 * Per-linked-account visibility mirror (S1, D767).
 *
 * Proactive events — doorbell, motion, connectivity, detections, state
 * changes — fire on the event bus with no directive and no token in hand, so
 * they cannot ask the user store per event (D49: a one-shot event never gates
 * on a fallible read). This mirror holds, per linked account, the exposed
 * devices that account's hub user may VIEW, refreshed off the event path, and
 * the event path reads it synchronously.
 *
 * It is also what keeps the user's Alexa account itself in step with the
 * grant: a device the user gains is pushed to that account; a device the user
 * loses is deleted from it. The two directions are deliberately asymmetric:
 *
 *  - a gain is applied on the first read that shows it;
 *  - a LOSS deletes the endpoint from the user's Alexa account — and with it
 *    every routine built on it — so it needs TWO consecutive refreshes to agree
 *    (D49's second read in the direction that destroys work), and a device
 *    whose metadata could not be read keeps its previous answer.
 *
 * The event gate itself follows the mirror immediately in both directions: a
 * refusal there loses one event, not the user's routines, and a revoked grant
 * must stop pushing quickly.
 *
 * A linked account with NO stored entry predates S1: every exposed device was
 * pushed to it. Its first refresh therefore starts from "everything", so a
 * scoped user's link is healed — the devices it should never have received
 * are queued for deletion like any other loss.
 */
import type { IScopedLogger } from '@camstack/types'
import type { AlexaAccessGate } from './access-gate.js'

/** What a linked account may view, as persisted. */
export type StoredVisibility =
  | { readonly all: true }
  | {
      readonly all?: false
      readonly view: readonly number[]
      /** Devices one refresh saw as lost; deleted from Alexa when the next agrees. */
      readonly pendingRemoval?: readonly number[]
    }

export type StoredVisibilityMap = Readonly<Record<string, StoredVisibility>>

/** Event-path gate. Unknown account ⇒ refused (fail closed). */
export function visibilityAllows(entry: StoredVisibility | undefined, deviceId: number): boolean {
  if (entry === undefined) return false
  if (entry.all === true) return true
  return entry.view.includes(deviceId)
}

export interface VisibilityChange {
  readonly userId: string
  /** Devices to push to this account now. */
  readonly added: readonly number[]
  /** Devices whose loss two refreshes agreed on — delete them from this account. */
  readonly removed: readonly number[]
}

export interface AccountVisibilityDeps {
  readonly gate: AlexaAccessGate
  readonly listLinkedUserIds: () => readonly string[]
  readonly listExposedDeviceIds: () => readonly number[]
  readonly getStored: () => StoredVisibilityMap
  readonly setStored: (next: StoredVisibilityMap) => Promise<void>
  readonly logger: IScopedLogger
}

function visibleSet(entry: StoredVisibility | undefined, exposed: readonly number[]): Set<number> {
  // No entry = a pre-S1 link, which was sent everything.
  if (entry === undefined || entry.all === true) return new Set(exposed)
  return new Set(entry.view)
}

export class AccountVisibilityMirror {
  private flight: Promise<readonly VisibilityChange[]> | null = null

  constructor(private readonly deps: AccountVisibilityDeps) {}

  /** Synchronous event-path read. */
  allows(userId: string, deviceId: number): boolean {
    return visibilityAllows(this.deps.getStored()[userId], deviceId)
  }

  /** Recompute every linked account. One pass at a time; a caller joins the
   *  pass in flight. Returns the changes the caller must apply to Alexa. */
  async refresh(): Promise<readonly VisibilityChange[]> {
    if (this.flight === null) {
      this.flight = this.refreshNow().finally(() => {
        this.flight = null
      })
    }
    return this.flight
  }

  private async refreshNow(): Promise<readonly VisibilityChange[]> {
    const exposed = this.deps.listExposedDeviceIds()
    const stored = this.deps.getStored()
    const next: Record<string, StoredVisibility> = {}
    const changes: VisibilityChange[] = []
    for (const userId of this.deps.listLinkedUserIds()) {
      const prev = stored[userId]
      const computed = await this.compute(userId, prev, exposed)
      if (computed === null) {
        // The user store could not be read: change nothing for this account.
        if (prev !== undefined) next[userId] = prev
        continue
      }
      next[userId] = computed.entry
      if (computed.change.added.length > 0 || computed.change.removed.length > 0) {
        changes.push(computed.change)
      }
    }
    await this.deps.setStored(next)
    return changes
  }

  private async compute(
    userId: string,
    prev: StoredVisibility | undefined,
    exposed: readonly number[],
  ): Promise<{ entry: StoredVisibility; change: VisibilityChange } | null> {
    const lookup = await this.deps.gate.principal(userId)
    if (lookup.kind === 'unavailable') return null
    const before = visibleSet(prev, exposed)
    const prevPending = new Set(
      prev !== undefined && prev.all !== true ? (prev.pendingRemoval ?? []) : [],
    )

    if (lookup.kind === 'found' && lookup.principal.kind === 'admin') {
      const added = prev === undefined ? [] : exposed.filter((id) => !before.has(id))
      return { entry: { all: true }, change: { userId, added, removed: [] } }
    }

    const view: number[] = []
    for (const deviceId of exposed) {
      if (lookup.kind === 'unknown-user') continue
      const verdict = await this.deps.gate.allows(lookup.principal, deviceId, 'view')
      // An unreadable device keeps its previous answer: one bad registry read
      // must not delete a camera from somebody's Alexa account.
      if (verdict === 'allowed' || (verdict === 'unknown' && before.has(deviceId))) {
        view.push(deviceId)
      }
    }
    const viewSet = new Set(view)
    const added = prev === undefined ? [] : view.filter((id) => !before.has(id))
    const lostNow = exposed.filter((id) => before.has(id) && !viewSet.has(id))
    // Confirmed: lost on the previous refresh AND still lost now.
    const removed = [...prevPending].filter((id) => !viewSet.has(id))
    const pendingRemoval = lostNow.filter((id) => !prevPending.has(id))
    if (lookup.kind === 'unknown-user' && prev === undefined) {
      this.deps.logger.warn(
        'alexa access: a linked Alexa account belongs to a hub user that no longer exists — it will be shown nothing',
        { meta: { userId } },
      )
    }
    return {
      entry: pendingRemoval.length > 0 ? { view, pendingRemoval } : { view },
      change: { userId, added, removed },
    }
  }
}
