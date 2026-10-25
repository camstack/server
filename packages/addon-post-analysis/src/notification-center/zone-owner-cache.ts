/**
 * WHICH ZONES a camera owns — the mirror the `zones` rule condition scopes
 * itself with (`zone-ownership.ts` holds the pure decision).
 *
 * The read has to be free at evaluation time: `evaluateRule` runs on the
 * persist hook, once per record, and D49 is explicit that a one-shot event
 * never gates on a fallible read. So ownership is mirrored in memory and
 * refreshed OFF the event path — on the same rule-reload tick that re-reads
 * rules, gated device states and the device directory (D8: reconcile on a
 * schedule, never trust an event to arrive).
 *
 * ── The two answers, and why they must stay distinguishable ────────────────
 *
 * `[]` means "this camera has no zones", and it is what makes a rule's zones
 * INERT for that camera (it matches whole-frame). `undefined` means "nobody
 * could answer", and it keeps the flat, pre-scoping verdict. Collapsing the
 * two would turn one failed read into a notification the operator explicitly
 * scoped away — so a device that could not be read is ABSENT from a refresh,
 * never present as an empty list. That contract belongs to
 * {@link NcZoneOwnershipCacheDeps.readZoneIds}, and it is the whole reason this
 * cache does not reuse the pipeline's `DeviceZoneResolver` verbatim: the
 * resolver's failure policy is "never lose zones" (it keeps the last catalogue
 * and can answer `[]` for a read that threw), and ours is "never invent an
 * absence".
 *
 * ── Failure policy ────────────────────────────────────────────────────────
 *
 * A refresh that throws KEEPS the previous snapshot, like the device directory
 * and unlike the device-state gate. Ownership is near-immutable — a polygon
 * does not move to another camera — so a stale entry is not a lie, while
 * dropping every entry on one blip would re-mute every camera this scoping
 * exists to un-mute. A watched device that a SUCCESSFUL refresh could not
 * answer for is dropped to unknown (flat semantics), and says so once.
 */

import type { IScopedLogger } from '@camstack/types'
import type { NcZoneOwnerLookup } from './zone-ownership.js'

export interface NcZoneOwnershipCacheDeps {
  readonly logger: IScopedLogger
  /**
   * The zone ids each device owns. A device that could not be read is ABSENT
   * from the map — never present with an empty list (see the module docblock).
   */
  readonly readZoneIds: (ids: readonly number[]) => Promise<ReadonlyMap<number, readonly string[]>>
}

export class NcZoneOwnershipCache {
  private owned: ReadonlyMap<number, readonly string[]> = new Map()
  private ids: readonly number[] = []
  /** Devices already reported as unreadable — keeps the line to one per episode. */
  private readonly reportedUnknown = new Set<number>()

  constructor(private readonly deps: NcZoneOwnershipCacheDeps) {}

  /**
   * The cameras worth reading — recomputed from the rule set, so a hub with no
   * zone-scoped multi-camera rule does no work at all.
   */
  setWatched(ids: readonly number[]): void {
    this.ids = [...new Set(ids)].sort((a, b) => a - b)
  }

  watched(): readonly number[] {
    return this.ids
  }

  /** Hot-path read. No I/O, no await — this runs per event, inside the engine. */
  get(deviceId: number): readonly string[] | undefined {
    return this.owned.get(deviceId)
  }

  /** A bound {@link NcZoneOwnerLookup} that always sees the CURRENT snapshot. */
  lookup(): NcZoneOwnerLookup {
    return (deviceId: number) => this.get(deviceId)
  }

  /**
   * Re-read every watched camera's catalogue. Never throws: an unreachable
   * zones capability must not take the notification centre's reload tick with
   * it.
   */
  async refresh(): Promise<void> {
    if (this.ids.length === 0) {
      this.owned = new Map()
      this.reportedUnknown.clear()
      return
    }
    try {
      const next = await this.deps.readZoneIds(this.ids)
      this.owned = new Map(next)
      for (const id of this.ids) {
        if (next.has(id)) {
          this.reportedUnknown.delete(id)
          continue
        }
        if (this.reportedUnknown.has(id)) continue
        this.reportedUnknown.add(id)
        // A rule that quietly keeps its old, camera-blind verdict is exactly
        // the silence this whole task is about — say it, per camera.
        this.deps.logger.warn(
          'zone ownership unreadable — this camera keeps the UNSCOPED zone verdict',
          { tags: { deviceId: id } },
        )
      }
    } catch (err) {
      this.deps.logger.warn('zone ownership refresh failed — keeping the previous catalogue', {
        meta: { watched: this.ids.length, error: String(err) },
      })
    }
  }
}
