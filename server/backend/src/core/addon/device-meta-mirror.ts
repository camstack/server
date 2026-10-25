/**
 * The hub-process mirror of every device's persisted `parentDeviceId`, `type`
 * and `location` — and the rule that decides how much of the fleet a device
 * event is allowed to make it re-read.
 *
 * ## Why the mirror exists at all
 *
 * The scope matcher's parent→child accessory inheritance (`getDeviceAncestors`
 * in `trpc.context.ts`) needs a deviceId's ancestor chain on EVERY scoped
 * request, synchronously. The hub `DeviceRegistry` only knows devices
 * registered IN the hub process, so it is EMPTY for every forked provider
 * (reolink, hikvision, …): a grant on a forked camera never reached its
 * siren/floodlight/PIR children (measured 0/6 providers inherited). The
 * authoritative parentage lives in the device-manager's persisted meta.
 *
 * ## The number this file exists to explain
 *
 * `FleetReadCensus` on the live hub, 120-second boot window, 2026-08-27
 * (four consecutive boots, 4 886 / 4 904 / 4 910 / 4 960):
 *
 *     site  DeviceRowStore.list < DeviceRowStore.listFleet < listAll
 *     calls 4 904      rows 4 987 368      perMin 2 451
 *
 * 4 987 368 ÷ 4 904 = **1 017.0** — the whole fleet, every single call. The
 * same census puts the boot's device count at 1 017 and the per-device chains
 * (`allocateDeviceId`, `getChildren`) at ~1 024 calls each, so this site is
 * ~4.8 reads per device.
 *
 * The refresh was already single-flighted (`single-flight-refresh.ts`) and
 * that was not enough, because single-flight bounds CONCURRENCY, not RATE: the
 * follow-up starts the instant the previous run ends, so a burst that keeps
 * producing events for two minutes produces rebuilds for two minutes. The
 * missing bound is not a timer — it is the observation that **a mirror of
 * three fields must not re-read a thousand rows because one device's `name`
 * changed.** Two rules, both here:
 *
 *  1. An event that names a meta `field` this mirror does not hold changes
 *     nothing, and asks for nothing ({@link MIRROR_IRRELEVANT_META_FIELDS}).
 *  2. An event that does change something changes it for ONE device, so the
 *     re-read is `listAll({ deviceIds: [that one] })` — the narrow read
 *     `device-queries.ts#listAll` has supported since the linked-devices panel
 *     needed it. Only the boot warm (`SystemAddonsReady`) reads the fleet.
 *
 * ## Why the irrelevant-field list is a DENY list
 *
 * The tempting shape is an allow list of the fields the mirror holds
 * (`location`, `type`). It is the wrong direction: a field added to
 * `device-meta-actions.ts` later would silently stop being mirrored, and the
 * symptom is a grant that quietly does not apply. A deny list fails the other
 * way — an unrecognised field costs ONE row and stays correct. The list only
 * ever needs to grow, and growing it late costs a row, not a bug.
 *
 * ## What a scoped refresh must still do
 *
 * A full rebuild removed a device that had disappeared, because it replaced
 * the map. A scoped one must do that explicitly: an id that was asked for and
 * did NOT come back is gone from the mirror — never a fabricated row, the same
 * contract `DeviceRowStore.getMany` states for a fleet it does not know. A
 * read that THROWS is not that: it changes nothing at all (D49).
 */

import type { DeviceMetaLike, IScopedLogger } from '@camstack/types'
import { errMsg } from '@camstack/types'
import type { RefreshScope, SingleFlightRefresh } from './single-flight-refresh.js'
import { createSingleFlightRefresh } from './single-flight-refresh.js'

/**
 * Meta fields a `DeviceMetaChanged` can name that this mirror provably does
 * not hold. Enumerated from every `field:` literal `device-meta-actions.ts`
 * emits; `location` and `type` are deliberately ABSENT because those two are
 * the mirror.
 */
export const MIRROR_IRRELEVANT_META_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'disabled',
  'metadata',
  'display',
  'role',
  'integrationId',
  'linkDeviceId',
  'primaryChildEntityId',
  'childLayout',
])

/** How much of the fleet one device event obliges the mirror to re-read. */
export type MirrorRefreshScope =
  | { readonly kind: 'device'; readonly deviceId: number }
  | { readonly kind: 'fleet' }
  | { readonly kind: 'none' }

/**
 * Classify one device-lifecycle event's payload.
 *
 * `none` only for a payload that NAMES a field the mirror does not hold —
 * that is a claim about the event, not a guess about the device. A payload
 * this cannot read at all falls back to `fleet`: an unparseable event must
 * never silently skip a refresh, because the failure mode is an authorisation
 * mirror that quietly stops converging.
 */
export function classifyDeviceEvent(data: unknown): MirrorRefreshScope {
  if (data === null || typeof data !== 'object') return { kind: 'fleet' }
  const field: unknown = Reflect.get(data, 'field')
  if (typeof field === 'string' && MIRROR_IRRELEVANT_META_FIELDS.has(field)) {
    return { kind: 'none' }
  }
  const deviceId: unknown = Reflect.get(data, 'deviceId')
  if (typeof deviceId !== 'number' || !Number.isFinite(deviceId)) return { kind: 'fleet' }
  return { kind: 'device', deviceId }
}

/** One device's mirrored fields. */
interface MirroredMeta {
  readonly type: string
  readonly location: string | null
}

/** Slim `deviceManager.listAll` reader. `deviceIds === null` is the whole fleet. */
export type FleetSlimReader = (deviceIds: readonly number[] | null) => Promise<unknown>

/** What the mirror falls back to for a device the persisted sweep has not
 *  reached yet — the hub's own live registry (hub-resident devices only). */
export interface LiveDeviceFallback {
  parentDeviceId(deviceId: number): number | null
  type(deviceId: number): string | null
  location(deviceId: number): string | null
}

/** Max ancestor hops — defence-in-depth against a corrupt parent cycle. */
const MAX_ANCESTOR_HOPS = 8

export class DeviceMetaMirror {
  private readonly parents = new Map<number, number>()
  private readonly meta = new Map<number, MirroredMeta>()
  private readonly gate: SingleFlightRefresh

  constructor(
    private readonly read: FleetSlimReader,
    private readonly live: LiveDeviceFallback,
    private readonly logger: IScopedLogger,
  ) {
    this.gate = createSingleFlightRefresh((scope) => this.refresh(scope))
  }

  /** Ask for a refresh covering exactly what the event changed. */
  onDeviceEvent(data: unknown): void {
    const scope = classifyDeviceEvent(data)
    if (scope.kind === 'none') return
    void this.gate.request(scope.kind === 'fleet' ? null : new Set([scope.deviceId]))
  }

  /** Warm (or re-warm) the whole fleet — the boot sweep, and the D8 reconcile
   *  that repairs anything a dropped event would have left behind. */
  async refreshAll(): Promise<void> {
    await this.gate.request(null)
  }

  /** Parent of a device: mirror first (covers forked devices), then the live
   *  hub registry (covers a hub-local device before the first warm). */
  parentOf(deviceId: number): number | null {
    const mirrored = this.parents.get(deviceId)
    if (mirrored !== undefined) return mirrored
    return this.live.parentDeviceId(deviceId)
  }

  /** Persisted `DeviceType` string, or null when unknown. */
  typeOf(deviceId: number): string | null {
    const mirrored = this.meta.get(deviceId)
    if (mirrored !== undefined) return mirrored.type
    return this.live.type(deviceId)
  }

  /** Persisted operator `location` label, or null when unset/unknown. */
  locationOf(deviceId: number): string | null {
    const mirrored = this.meta.get(deviceId)
    if (mirrored !== undefined) return mirrored.location
    return this.live.location(deviceId)
  }

  /** The whole mirrored fleet — fuels fleet-wide selector expansion. */
  list(): readonly DeviceMetaLike[] {
    const out: DeviceMetaLike[] = []
    for (const [id, m] of this.meta) {
      out.push({
        id,
        type: m.type,
        location: m.location,
        parentDeviceId: this.parents.get(id) ?? null,
      })
    }
    return out
  }

  /** Ancestor chain (parent, grandparent, …), bounded. Empty for a top-level
   *  device or one the hub has never heard of. */
  ancestorsOf(deviceId: number): readonly number[] {
    const out: number[] = []
    let current = deviceId
    for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop++) {
      const parent = this.parentOf(current)
      if (parent === null || parent === current) break
      out.push(parent)
      current = parent
    }
    return out
  }

  private async refresh(scope: RefreshScope): Promise<void> {
    try {
      const ids = scope === null ? null : [...scope]
      const rows: unknown = await this.read(ids)
      if (!Array.isArray(rows)) return
      const nextParents = new Map<number, number>()
      const nextMeta = new Map<number, MirroredMeta>()
      for (const row of rows) {
        if (row === null || typeof row !== 'object') continue
        const id: unknown = Reflect.get(row, 'id')
        if (typeof id !== 'number') continue
        const parent: unknown = Reflect.get(row, 'parentDeviceId')
        if (typeof parent === 'number') nextParents.set(id, parent)
        const type: unknown = Reflect.get(row, 'type')
        const location: unknown = Reflect.get(row, 'location')
        nextMeta.set(id, {
          type: typeof type === 'string' ? type : '',
          location: typeof location === 'string' ? location : null,
        })
      }
      if (ids === null) {
        this.parents.clear()
        for (const [k, v] of nextParents) this.parents.set(k, v)
        this.meta.clear()
        for (const [k, v] of nextMeta) this.meta.set(k, v)
        return
      }
      // Scoped: apply exactly the ids that were ASKED for. An id the fleet did
      // not answer with is gone — the one thing the full rebuild used to do
      // implicitly by replacing the map.
      for (const id of ids) {
        const m = nextMeta.get(id)
        if (m === undefined) {
          this.parents.delete(id)
          this.meta.delete(id)
          continue
        }
        this.meta.set(id, m)
        const parent = nextParents.get(id)
        if (parent === undefined) this.parents.delete(id)
        else this.parents.set(id, parent)
      }
    } catch (err) {
      this.logger.debug('device-meta mirror refresh failed — keeping previous', {
        meta: { error: errMsg(err), scope: scope === null ? 'fleet' : scope.size },
      })
    }
  }
}
