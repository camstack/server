/**
 * The claims half of the hub runtime-state mirror (D663): which caps of a
 * device are claimed, by whom, and what the MERGED view of each claimed cap
 * currently is. `DeviceStateMirror` owns the native shadow, the seeding and
 * the disk writes; this class owns the two maps the merge lives in and the
 * rule for what a consumer sees.
 *
 * The view of a claimed cap is `mergeOwned(native, claim)`. When the merge is
 * a slice it is what reads answer and what is emitted. When it is HELD, what
 * reads answer depends on WHY: a bad overlay (every value present, schema
 * refused it) keeps the last good slice readable; a value or native that has
 * not arrived yet answers nothing — otherwise the previous merge would answer a
 * newly claimed field from the native (S5, D62). Held transitions log once per
 * (device, cap, reason) with `tags: { deviceId }` (D391).
 */
import type { z } from 'zod'
import type { ClaimOutcome, IScopedLogger } from '@camstack/types'
import { ALL_CAPABILITY_DEFINITIONS } from '@camstack/types'
import { shallowEqual } from './device-projection.js'
import { type MergedSlice, mergeOwned, type OwnedCap, type OwnedCaps } from './field-ownership.js'

/** Resolves a cap's `runtimeState` schema by name; null when it declares none. */
export type RuntimeStateSchemaLookup = (capName: string) => z.ZodType | null

/** Per (device, cap) state of a claimed cap: what the merge last said, and the
 *  last GOOD merged slice — kept readable while a bad overlay holds the cap. */
export interface ClaimedView {
  readonly merged: MergedSlice
  readonly visible: Readonly<Record<string, unknown>> | null
}

/** What `derive` says about a claim: the view to install, and whether a held one is the owner's fault. */
interface DerivedView {
  readonly view: ClaimedView
  readonly badOverlay: boolean
}

/** What the views need from their owner: the schema, the log and the public emit. */
export interface ClaimViewSink {
  readonly logger: IScopedLogger
  readonly schemaFor: RuntimeStateSchemaLookup
  emitSlice(deviceId: number, capName: string, slice: Record<string, unknown>): void
}

let defaultSchemaTable: Map<string, z.ZodType> | null = null
/** Lazily indexes the codegen'd cap set — the hub already carries the barrel. */
export function defaultSchemaFor(capName: string): z.ZodType | null {
  if (defaultSchemaTable === null) {
    defaultSchemaTable = new Map()
    for (const def of ALL_CAPABILITY_DEFINITIONS) {
      if (def.runtimeState) defaultSchemaTable.set(def.name, def.runtimeState)
    }
  }
  return defaultSchemaTable.get(capName) ?? null
}

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

export function sameOwnedCap(a: OwnedCap, b: OwnedCap): boolean {
  return (
    a.owner === b.owner &&
    a.mode === b.mode &&
    sameStringList(a.fields, b.fields) &&
    shallowEqual({ ...a.values }, { ...b.values })
  )
}

type ClaimRefusal = Extract<ClaimOutcome, { ok: false }>

export function refused(code: ClaimRefusal['code'], message: string): ClaimOutcome {
  return { ok: false, code, message }
}

export class ClaimViews {
  /** Claims by device, by cap. Absent for every device without one. */
  private readonly owned = new Map<number, Map<string, OwnedCap>>()
  /** The merged view of each claimed cap; recomputed on every native or owned write. */
  private readonly views = new Map<number, Map<string, ClaimedView>>()

  constructor(private readonly sink: ClaimViewSink) {}

  claim(deviceId: number, capName: string): OwnedCap | undefined {
    return this.owned.get(deviceId)?.get(capName)
  }

  setClaim(deviceId: number, capName: string, claim: OwnedCap): void {
    this.ownedFor(deviceId).set(capName, claim)
  }

  /** Removes the claim AND its view. */
  deleteClaim(deviceId: number, capName: string): void {
    this.owned.get(deviceId)?.delete(capName)
    this.views.get(deviceId)?.delete(capName)
  }

  /** Fill gaps only: a claim already in memory was written through and is newer than the row. */
  seedClaims(deviceId: number, claims: OwnedCaps): void {
    if (claims.size === 0) return
    const mine = this.ownedFor(deviceId)
    for (const [capName, cap] of claims) if (!mine.has(capName)) mine.set(capName, cap)
  }

  clearDevice(deviceId: number): void {
    this.owned.delete(deviceId)
    this.views.delete(deviceId)
  }

  ownedCaps(deviceId: number): OwnedCaps {
    return new Map(this.owned.get(deviceId) ?? [])
  }

  claimsOf(deviceId: number): Iterable<[string, OwnedCap]> {
    return this.owned.get(deviceId) ?? []
  }

  /** Devices with at least one view — for the whole-system dump. */
  deviceIds(): Iterable<number> {
    return this.views.keys()
  }

  isClaimed(deviceId: number, capName: string): boolean {
    return this.views.get(deviceId)?.has(capName) ?? false
  }

  /** `undefined` when the cap is not claimed; `null` when it is claimed and held with nothing to show. */
  visible(deviceId: number, capName: string): Readonly<Record<string, unknown>> | null | undefined {
    const view = this.views.get(deviceId)?.get(capName)
    return view === undefined ? undefined : view.visible
  }

  /** Every claimed cap of a device that currently has something to show. */
  *visibleCaps(deviceId: number): Iterable<[string, Readonly<Record<string, unknown>>]> {
    for (const [capName, view] of this.views.get(deviceId) ?? []) {
      if (view.visible) yield [capName, view.visible]
    }
  }

  /** What the merge says for a claimed cap; null when the cap is not claimed. */
  effective(deviceId: number, capName: string): MergedSlice | null {
    const view = this.views.get(deviceId)?.get(capName)
    if (!view) return null
    return view.merged.kind === 'slice'
      ? { kind: 'slice', slice: { ...view.merged.slice } }
      : { kind: 'held', reason: view.merged.reason }
  }

  view(deviceId: number, capName: string): ClaimedView | undefined {
    return this.views.get(deviceId)?.get(capName)
  }

  /** Put a view back (rollback of a failed write-through); `undefined` removes it. */
  restoreView(deviceId: number, capName: string, view: ClaimedView | undefined): void {
    if (view) this.viewsFor(deviceId).set(capName, view)
    else this.views.get(deviceId)?.delete(capName)
  }

  /**
   * Recompute a claimed cap's merged view and emit it when it is a slice and
   * either changed or `emitUnchanged` (the native moved). A held view emits
   * nothing and logs once per transition, naming the fields; a bad overlay
   * keeps the last good slice readable, a missing value or native does not.
   */
  recompute(
    deviceId: number,
    capName: string,
    claim: OwnedCap,
    native: Readonly<Record<string, unknown>> | null,
    emitUnchanged: boolean,
  ): void {
    const views = this.viewsFor(deviceId)
    const prior = views.get(capName)
    const { view, badOverlay } = this.derive(prior, capName, claim, native)
    views.set(capName, view)
    const merged = view.merged
    if (merged.kind === 'slice') {
      const changed = !prior?.visible || !shallowEqual({ ...prior.visible }, { ...merged.slice })
      if (changed || emitUnchanged) this.sink.emitSlice(deviceId, capName, { ...merged.slice })
      return
    }
    if (prior?.merged.kind === 'held' && prior.merged.reason === merged.reason) return
    // A bad overlay is the owner's fault and worth a warn; a value or native
    // that has not arrived yet is the expected order of things.
    const extras = {
      tags: { deviceId },
      meta: { cap: capName, owner: claim.owner, reason: merged.reason },
    }
    if (badOverlay) this.sink.logger.warn('claimed cap held — nothing emitted for it', extras)
    else this.sink.logger.debug('claimed cap held — nothing emitted for it', extras)
  }

  /**
   * The view a claim has NOW — set, never emitted, never logged. A claim is
   * written through, and readers must see it from the moment it is accepted
   * (S5): without this, `capSlice` answered the NATIVE for an already-claimed
   * field for the whole row round-trip (D663 re-review N-5). The emit is judged
   * later, by `recompute`, against what consumers last saw.
   */
  previewView(
    deviceId: number,
    capName: string,
    claim: OwnedCap,
    native: Readonly<Record<string, unknown>> | null,
  ): void {
    const views = this.viewsFor(deviceId)
    views.set(capName, this.derive(views.get(capName), capName, claim, native).view)
  }

  /** The one rule for what a claimed cap shows: the merge when it is a slice; on
   *  a bad overlay the last good slice stays readable; a value or native not yet
   *  arrived shows nothing. */
  private derive(
    prior: ClaimedView | undefined,
    capName: string,
    claim: OwnedCap,
    native: Readonly<Record<string, unknown>> | null,
  ): DerivedView {
    const merged = mergeOwned(native, claim, this.sink.schemaFor(capName))
    if (merged.kind === 'slice')
      return { view: { merged, visible: merged.slice }, badOverlay: false }
    const complete = claim.fields.every((f) => Object.hasOwn(claim.values, f))
    const badOverlay = complete && (native !== null || claim.mode === 'add')
    return {
      view: { merged, visible: badOverlay ? (prior?.visible ?? null) : null },
      badOverlay,
    }
  }

  /** The merged view for a claim that arrived by seed: computed, never emitted. */
  seedView(
    deviceId: number,
    capName: string,
    claim: OwnedCap,
    native: Readonly<Record<string, unknown>> | null,
  ): void {
    const views = this.viewsFor(deviceId)
    if (views.has(capName)) return
    const merged = mergeOwned(native, claim, this.sink.schemaFor(capName))
    views.set(capName, { merged, visible: merged.kind === 'slice' ? merged.slice : null })
  }

  private ownedFor(deviceId: number): Map<string, OwnedCap> {
    let perCap = this.owned.get(deviceId)
    if (!perCap) {
      perCap = new Map()
      this.owned.set(deviceId, perCap)
    }
    return perCap
  }

  private viewsFor(deviceId: number): Map<string, ClaimedView> {
    let views = this.views.get(deviceId)
    if (!views) {
      views = new Map()
      this.views.set(deviceId, views)
    }
    return views
  }
}
