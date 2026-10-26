/**
 * The composer's side of grafts (D663, Task 10): WHEN a cap a customization
 * ADDS is grafted, removed or refused — `GraftHost` is only the how. Split from
 * `composer.ts`.
 *
 * - Decided at PLAN time only (rule 2): every added cap is grafted; a grafted
 *   cap the plan now finds native is ungrafted (its event was dropped, D8).
 * - NATIVE ALWAYS WINS (I-2). A foreign `native-registered` on a grafted cap
 *   ungrafts it (the claim stays). One that lands while a plan is in flight —
 *   after the target's description was read, before the graft — is remembered
 *   per described device, so that plan never grafts over it. A foreign
 *   `native-unregistered` never re-grafts (D659).
 * - A cap no graft serves is NAMED for the block verdict (I-1): refused by the
 *   host, or taken by a native. Every added cap unserved → the block fails.
 * - A binding a PREVIOUS composer process left (a respawn, D5) is retracted
 *   when a settled plan does not want it (I-3), or when the gate releases the
 *   add claim of a block that is gone — after reading that the binding IS the
 *   composer's; a read that fails retracts nothing (D49).
 */
import {
  COMPOSER_ADDON_ID,
  type CompositionFeaturePlan,
  type CompositionSourceRef,
  errMsg,
  type IScopedLogger,
} from '@camstack/types'
import { addedCapsOf, type ComposerGraftPorts, type DescribeTarget } from './existing-target.js'

/** A foreign native now serves the grafted cap: the claim stays (Task 10 rule 2). */
export const NATIVE_APPEARED_UNGRAFT_REASON = 'a native provider appeared'
/** The block's add claim was released by the D49 gate (deleted, disabled, feature removed): its graft goes with it. */
export const NO_LONGER_ADDED_UNGRAFT_REASON = 'the block no longer adds this cap'
/** A binding a previous composer process left, that nothing wants any more (I-3). */
export const STALE_GRAFT_RETRACT_REASON =
  'a graft left by a previous composer process that no plan wants'

/** The `device.bindings-changed` facts the graft decisions read. */
export interface BindingsChangeFacts {
  readonly deviceId: number
  readonly capName: string
  readonly reason: string
  readonly addonId: string
}

export interface GraftPlanInput {
  readonly deviceId: number
  readonly ref: CompositionSourceRef
  readonly features: readonly CompositionFeaturePlan[]
  /** The description the plan used: cap → the addon serving it (`getBindings`). */
  readonly nativeCaps: ReadonlyMap<string, string>
  readonly enabled: boolean
  /** Planned without problems; a block whose plan failed holds what it has (rule 4). */
  readonly settled: boolean
}

/** What a block's added caps say about its verdict: null when every one is served. */
export interface GraftVerdict {
  /** Nothing the block adds can be served. */
  readonly allUnserved: boolean
  readonly reason: string
}

type CapReasons = ReadonlyMap<string, string>

function withEntry<V>(map: ReadonlyMap<number, V>, key: number, value: V): ReadonlyMap<number, V> {
  return new Map([...map, [key, value]])
}

function nativeTakenReason(addonId: string, when: string): string {
  return `a native provider (${addonId}) ${when} — the cap is not grafted and its claim is kept`
}

export class ComposerGrafts {
  /** Per device: the added caps no graft serves, and why. Reset by each plan of that device. */
  private unserved: ReadonlyMap<number, CapReasons> = new Map()
  /** Per DESCRIBED device: foreign natives registered since its description was read (cap → addonId). */
  private foreignSince: ReadonlyMap<number, CapReasons> = new Map()

  constructor(
    private readonly ports: ComposerGraftPorts | undefined,
    private readonly logger: IScopedLogger,
    private readonly readBindings: DescribeTarget,
  ) {}

  /** A description of `deviceId` is about to be read: it covers every registration before now. */
  describing(deviceId: number): void {
    this.foreignSince = withEntry(this.foreignSince, deviceId, new Map())
  }

  onBindingsChanged(data: BindingsChangeFacts): void {
    if (data.addonId === COMPOSER_ADDON_ID) return
    this.remember(data)
    const ports = this.ports
    if (data.reason !== 'native-registered' || ports === undefined) return
    if (!ports.grafted(data.deviceId).has(data.capName)) return
    this.logger.info(
      'a native provider appeared on a grafted cap — the graft is removed; the claim stays',
      { tags: { deviceId: data.deviceId }, meta: { cap: data.capName, addonId: data.addonId } },
    )
    ports.ungraft(data.deviceId, data.capName, NATIVE_APPEARED_UNGRAFT_REASON)
    this.setUnserved(data.deviceId, data.capName, nativeTakenReason(data.addonId, 'appeared'))
  }

  /** Rule 2, at plan time only: graft what the plan adds; ungraft what it finds native; retract what a previous process left. */
  plan(input: GraftPlanInput): void {
    const ports = this.ports
    if (ports === undefined) return
    const { deviceId } = input
    const added = input.enabled && input.settled ? addedCapsOf(input.features) : []
    // A cap the device now serves itself is no longer an add (D944 refuses the
    // replace). The graft still comes off: a native always wins.
    const nativeNow = new Set(
      [...input.nativeCaps.entries()]
        .filter(([, owner]) => owner !== COMPOSER_ADDON_ID)
        .map(([cap]) => cap),
    )
    const replaced = new Set(input.features.filter((f) => f.mode === 'replace').map((f) => f.cap))
    for (const cap of ports.grafted(deviceId)) {
      if (!nativeNow.has(cap) && !replaced.has(cap)) continue
      this.logger.info(
        'a native provider serves a grafted cap — the graft is removed; the claim stays',
        { tags: { deviceId }, meta: { cap } },
      )
      ports.ungraft(deviceId, cap, NATIVE_APPEARED_UNGRAFT_REASON)
    }
    if (input.settled) this.retractUnwanted(input, new Set(added))
    const foreign = this.foreignSince.get(deviceId) ?? new Map<string, string>()
    const unserved = new Map<string, string>()
    for (const cap of added) {
      const other = foreign.get(cap)
      if (other !== undefined) {
        const reason = nativeTakenReason(other, 'registered while the block was planning')
        this.logger.warn('graft skipped — a native provider serves the cap (native always wins)', {
          tags: { deviceId },
          meta: { cap, addonId: other },
        })
        unserved.set(cap, reason)
        continue
      }
      const outcome = ports.graft(deviceId, input.ref.stableId, cap)
      if (outcome.kind === 'refused') unserved.set(cap, `graft refused: ${outcome.reason}`)
    }
    this.unserved = withEntry(this.unserved, deviceId, unserved)
  }

  /** The gate released a claim: a graft of that cap goes with it; a previous process's binding is retracted once read as the composer's. */
  async released(deviceId: number, capName: string): Promise<void> {
    const ports = this.ports
    if (ports === undefined) return
    this.setUnserved(deviceId, capName, null)
    if (ports.grafted(deviceId).has(capName)) {
      ports.ungraft(deviceId, capName, NO_LONGER_ADDED_UNGRAFT_REASON)
      return
    }
    let read: Awaited<ReturnType<DescribeTarget>>
    try {
      read = await this.readBindings(deviceId)
    } catch (err: unknown) {
      read = { kind: 'unreadable', error: errMsg(err) }
    }
    if (read.kind === 'unreadable') {
      this.logger.warn(
        'a released claim: the bindings could not be read — a graft left by a previous process, if any, is not retracted (D49)',
        { tags: { deviceId }, meta: { cap: capName, error: read.error } },
      )
      return
    }
    if (read.caps.get(capName) === COMPOSER_ADDON_ID)
      ports.retractStale(deviceId, capName, STALE_GRAFT_RETRACT_REASON)
  }

  /** The target row is gone: nothing about it is reported any more. */
  gone(deviceId: number): void {
    this.unserved = new Map([...this.unserved].filter(([id]) => id !== deviceId))
  }

  verdict(deviceId: number, features: readonly CompositionFeaturePlan[]): GraftVerdict | null {
    const added = addedCapsOf(features)
    const unserved = this.unserved.get(deviceId) ?? new Map<string, string>()
    const named = added.flatMap((cap) => {
      const reason = unserved.get(cap)
      return reason === undefined ? [] : [`${cap}: ${reason}`]
    })
    if (named.length === 0) return null
    return {
      // Nothing the block does is served: every feature is an add, and none is grafted.
      allUnserved: named.length === added.length && added.length === features.length,
      reason: `added caps no graft serves — ${named.join('; ')}`,
    }
  }

  private retractUnwanted(input: GraftPlanInput, wanted: ReadonlySet<string>): void {
    const ports = this.ports
    if (ports === undefined) return
    const own = ports.grafted(input.deviceId)
    for (const [cap, addonId] of input.nativeCaps) {
      if (addonId !== COMPOSER_ADDON_ID || own.has(cap) || wanted.has(cap)) continue
      this.logger.info('a graft left by a previous composer process is retracted', {
        tags: { deviceId: input.deviceId },
        meta: { cap },
      })
      ports.retractStale(input.deviceId, cap, STALE_GRAFT_RETRACT_REASON)
    }
  }

  private remember(data: BindingsChangeFacts): void {
    const seen = this.foreignSince.get(data.deviceId)
    if (seen === undefined) return
    if (data.reason === 'native-registered') {
      this.foreignSince = withEntry(
        this.foreignSince,
        data.deviceId,
        new Map([...seen, [data.capName, data.addonId]]),
      )
    } else if (data.reason === 'native-unregistered' && seen.get(data.capName) === data.addonId) {
      this.foreignSince = withEntry(
        this.foreignSince,
        data.deviceId,
        new Map([...seen].filter(([cap]) => cap !== data.capName)),
      )
    }
  }

  private setUnserved(deviceId: number, cap: string, reason: string | null): void {
    const current = this.unserved.get(deviceId) ?? new Map<string, string>()
    const next = new Map([...current].filter(([c]) => c !== cap))
    if (reason !== null) next.set(cap, reason)
    this.unserved = withEntry(this.unserved, deviceId, next)
  }
}
