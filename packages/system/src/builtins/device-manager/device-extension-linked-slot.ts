/**
 * The device manager's side of `device-extension` (D648): the
 * `linked-devices` slot — since D655 the only editor of a camera's linked
 * devices and of their tracked-event opt-in.
 *
 * Nothing new is persisted and nothing is migrated:
 *
 *  - `list` reads `_linkedDeviceIds` with `parseLinkedDevicesConfig` — the
 *    parser `getLinkedDevices` resolves through — so the slot's value IS the
 *    operator's pick list the resolver sees; and `_linkedDeviceTrackedIds`
 *    with `parseTrackedOptIn`, the parser the resolver's
 *    `producesTrackedEvents` reads; and the devices the camera links BY
 *    STRUCTURE (`impliedSources`: tree children, a picked container's child —
 *    what the old section offered opt-in toggles for), resolved by the
 *    resolver's own function over the camera's subtree, never the fleet;
 *  - `set` writes through `applyLinkedDevicesPatch`, after refusing new picks
 *    that are never legitimate (`refusedLinkedPicks`) and a NEW opt-in for a
 *    device the camera does not link (`refusedTrackedOptIns`) — an opt-in
 *    already stored is always accepted, so a read writes back unchanged;
 *  - the picked ids are labelled and judged from ONE indexed read of the
 *    device manager's own ledger (`rows.getMany`), never a fleet listing —
 *    only `candidates`, which is the editor asking for the fleet, lists it;
 *  - `candidates` is the picker's own rule: every device but the camera, its
 *    tree children (always linked, not a pick) and containers (never a pick —
 *    their children are), with devices in the camera's location SUGGESTED and
 *    nothing saved on its own (D356).
 */
import type { DeviceInfo, ExtensionCandidate, ExtensionSlotSource } from '@camstack/types'
import {
  createDeviceExtensionProvider,
  defineExtensionSlotProvider,
  DeviceType,
  type IDeviceExtensionProvider,
} from '@camstack/types'
import {
  applyLinkedDevicesPatch,
  LINK_CANDIDATE_PROJECTION,
  type LinkCandidate,
  LINKED_IDS_CONFIG_KEY,
  LINKED_TRACKED_IDS_CONFIG_KEY,
  parseLinkedDevicesConfig,
  parseTrackedOptIn,
  refusedLinkedPicks,
  resolveLinkedDeviceIds,
} from './device-linked-devices.js'
import type { DeviceRow } from './device-row-store.js'
import type { ProviderContext } from './device-provider-context.js'
import { listAll } from './device-queries.js'

/** The routing prefix of this owner's `slotRef`s. */
export const DEVICE_MANAGER_EXTENSION_SOURCE = 'device-manager'

/** The store the slot reads and writes, named (D62). */
export const LINKED_DEVICES_AUTHORITY: string = `device-manager:${LINKED_IDS_CONFIG_KEY}`

/** The two ledger fields a picked id is judged and labelled by. */
interface PickedDevice {
  readonly name: string
  readonly type: string
}

/**
 * The picked ids' ledger fields, from ONE indexed read of the device manager's
 * own store (`rows.getMany`) — never the whole fleet to label a handful of ids.
 * An id no device has is absent from the map.
 */
function pickedFrom(rows: ReadonlyMap<number, DeviceRow>): ReadonlyMap<number, PickedDevice> {
  const out = new Map<number, PickedDevice>()
  for (const [id, row] of rows) out.set(id, { name: row.meta.name, type: row.meta.type })
  return out
}

/** What a camera's picked id is, said once for the editor. */
function sourceOf(deviceId: number, byId: ReadonlyMap<number, PickedDevice>): ExtensionSlotSource {
  const device = byId.get(deviceId)
  if (device === undefined) {
    return {
      deviceId,
      name: null,
      health: 'missing',
      detail: 'No device has this id any more — it links nothing until removed.',
    }
  }
  if (device.type === DeviceType.Container) {
    return {
      deviceId,
      name: device.name,
      health: 'unavailable',
      detail:
        'A container is never a pick: its children are linked in its place. ' +
        'Pick the children instead.',
    }
  }
  return { deviceId, name: device.name, health: 'ok' }
}

/** What `refusedTrackedOptIns` judges: the opt-in written, and what it may name. */
export interface TrackedOptInWrite {
  readonly tracked: readonly number[]
  /** The picks being written. */
  readonly picked: readonly number[]
  /** Linked by structure: tree children, a picked container's child. */
  readonly implied: readonly number[]
  /** The opt-in as stored before this write. */
  readonly stored: readonly number[]
}

/**
 * Which ids of a written opt-in must be refused: a NEW opt-in for a device the
 * camera does not link. An id already stored is never refused — whatever was
 * read can be written back unchanged (a stale opt-in is removed by leaving it
 * out, never by being unable to save). The written list REPLACES the stored
 * one: since D655 the editor shows every stored opt-in, so nothing it sends
 * back is written blind.
 */
export function refusedTrackedOptIns(params: TrackedOptInWrite): readonly number[] {
  const allowed = new Set([...params.picked, ...params.implied, ...params.stored])
  return params.tracked.filter((id) => !allowed.has(id))
}

/** A ledger row as the pure link resolver reads it, or null for an unknown type. */
function toLinkCandidate(row: DeviceRow): LinkCandidate | null {
  const type = Object.values(DeviceType).find((t) => t === row.meta.type)
  if (type === undefined) return null
  return {
    id: row.meta.id,
    parentDeviceId: row.meta.parentDeviceId,
    location: row.meta.location,
    type,
    stableId: row.meta.stableId,
    ...(row.meta.primaryChildEntityId !== undefined
      ? { primaryChildEntityId: row.meta.primaryChildEntityId }
      : {}),
    ...(row.meta.role !== undefined ? { role: row.meta.role } : {}),
    name: row.meta.name,
  }
}

/** How deep a container nesting is walked — a cycle in the ledger must end. */
const MAX_CONTAINER_DEPTH = 8

/**
 * The devices the camera links BY STRUCTURE, labelled: what the resolver adds
 * beyond the picks. Computed by the resolver itself (`resolveLinkedDeviceIds`)
 * over the only rows it can reach — the picks, the camera's children, and the
 * descendants of every container among them — read level by level with ONE
 * indexed `listByParentMany` each, never the fleet.
 */
async function impliedLinks(
  pctx: ProviderContext,
  deviceId: number,
  manualIds: readonly number[],
  pickedRows: ReadonlyMap<number, DeviceRow>,
): Promise<readonly ExtensionSlotSource[]> {
  const rows = new Map<number, DeviceRow>(pickedRows)
  let parents: readonly number[] = [
    deviceId,
    ...[...pickedRows.values()]
      .filter((r) => r.meta.type === DeviceType.Container)
      .map((r) => r.meta.id),
  ]
  const walked = new Set<number>()
  for (let depth = 0; depth < MAX_CONTAINER_DEPTH && parents.length > 0; depth++) {
    for (const id of parents) walked.add(id)
    const byParent = await pctx.metaStore.rows.listByParentMany(parents)
    const next: number[] = []
    for (const children of byParent.values()) {
      for (const child of children) {
        rows.set(child.meta.id, child)
        if (child.meta.type === DeviceType.Container && !walked.has(child.meta.id)) {
          next.push(child.meta.id)
        }
      }
    }
    parents = next
  }
  const candidates = [...rows.values()].flatMap((r) => {
    const c = toLinkCandidate(r)
    return c === null ? [] : [c]
  })
  const picks = new Set(manualIds)
  return resolveLinkedDeviceIds({
    selfId: deviceId,
    config: { mode: 'manual', manualIds },
    candidates,
  })
    .filter((id) => !picks.has(id))
    .map((id) => ({ deviceId: id, name: rows.get(id)?.meta.name ?? null, health: 'ok' as const }))
}

function describeRefusal(deviceId: number, reason: 'self' | 'container' | 'unknown'): string {
  if (reason === 'self') return `${deviceId} is the camera itself`
  if (reason === 'container') return `${deviceId} is a container — pick its children`
  return `${deviceId} is not a device`
}

async function fleetOf(pctx: ProviderContext): Promise<ReadonlyMap<number, DeviceInfo>> {
  const all = await listAll(pctx, LINK_CANDIDATE_PROJECTION)
  return new Map(all.map((d) => [d.id, d]))
}

function candidatesFor(
  deviceId: number,
  byId: ReadonlyMap<number, DeviceInfo>,
): readonly ExtensionCandidate[] {
  const location = byId.get(deviceId)?.location ?? null
  const out: ExtensionCandidate[] = []
  for (const device of byId.values()) {
    if (device.id === deviceId) continue
    if (device.parentDeviceId === deviceId) continue
    if (device.type === DeviceType.Container) continue
    const suggested = location !== null && device.location === location
    const parent = device.parentDeviceId === null ? undefined : byId.get(device.parentDeviceId)
    out.push({
      deviceId: device.id,
      name: device.name,
      type: device.type,
      location: device.location,
      parentName: parent?.name ?? null,
      suggested,
      reason: suggested ? 'same location' : null,
    })
  }
  return out.toSorted(
    (a, b) => Number(b.suggested) - Number(a.suggested) || a.name.localeCompare(b.name),
  )
}

/** Build the `device-extension` provider the device manager registers. */
export function createDeviceManagerExtensionProvider(
  pctx: ProviderContext,
): IDeviceExtensionProvider {
  const linked = defineExtensionSlotProvider('linked-devices', {
    list: async (deviceId) => {
      const blob = await pctx.settings.readDeviceStore(deviceId)
      const { manualIds } = parseLinkedDevicesConfig(blob)
      const pickedRows = await pctx.metaStore.rows.getMany(manualIds)
      const byId = pickedFrom(pickedRows)
      const implied = await impliedLinks(pctx, deviceId, manualIds, pickedRows)
      return {
        authority: LINKED_DEVICES_AUTHORITY,
        activation: null,
        value: {
          slot: 'linked-devices',
          deviceIds: [...manualIds],
          trackedDeviceIds: [...parseTrackedOptIn(blob)],
        },
        sources: manualIds.map((id) => sourceOf(id, byId)),
        ...(implied.length > 0 ? { impliedSources: implied } : {}),
      }
    },
    set: async (deviceId, value) => {
      const [pickedRows, blob] = await Promise.all([
        pctx.metaStore.rows.getMany(value.deviceIds),
        pctx.settings.readDeviceStore(deviceId),
      ])
      const byId = pickedFrom(pickedRows)
      const refused = refusedLinkedPicks({
        selfId: deviceId,
        picked: value.deviceIds,
        persisted: parseLinkedDevicesConfig(blob).manualIds,
        fleet: byId,
      })
      if (refused.length > 0) {
        pctx.host.ctx.logger.warn('linked-devices: write refused — nothing persisted', {
          tags: { deviceId },
          meta: { refused },
        })
        throw new Error(
          `linked-devices on ${deviceId}: refused — ` +
            refused.map((r) => describeRefusal(r.deviceId, r.reason)).join('; '),
        )
      }
      const tracked = value.trackedDeviceIds
      if (tracked === undefined) {
        // A card built before D655: the pick list only, the opt-in untouched.
        await applyLinkedDevicesPatch(pctx, deviceId, { [LINKED_IDS_CONFIG_KEY]: value.deviceIds })
        return { applied: true, reload: 'none' }
      }
      const implied = await impliedLinks(pctx, deviceId, value.deviceIds, pickedRows)
      const notLinked = refusedTrackedOptIns({
        tracked,
        picked: value.deviceIds,
        implied: implied.map((s) => s.deviceId),
        stored: parseTrackedOptIn(blob),
      })
      if (notLinked.length > 0) {
        pctx.host.ctx.logger.warn('linked-devices: write refused — nothing persisted', {
          tags: { deviceId },
          meta: { trackedNotLinked: notLinked },
        })
        throw new Error(
          `linked-devices on ${deviceId}: refused — tracked events can only be opted in for a ` +
            `linked device, not ${notLinked.join(', ')}`,
        )
      }
      await applyLinkedDevicesPatch(pctx, deviceId, {
        [LINKED_IDS_CONFIG_KEY]: value.deviceIds,
        [LINKED_TRACKED_IDS_CONFIG_KEY]: [...new Set(tracked)],
      })
      return { applied: true, reload: 'none' }
    },
    candidates: async (deviceId) => candidatesFor(deviceId, await fleetOf(pctx)),
  })

  return createDeviceExtensionProvider({
    source: DEVICE_MANAGER_EXTENSION_SOURCE,
    label: 'Device manager',
    slots: [linked],
    // Local: the device manager OWNS the ledger this reads (R6).
    hostTypeOf: async (deviceId) =>
      (await pctx.metaStore.resolvePersistedById(deviceId))?.meta.type ?? null,
    logger: pctx.host.ctx.logger,
  })
}
