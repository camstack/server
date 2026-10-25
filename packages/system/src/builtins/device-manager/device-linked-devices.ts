/**
 * Linked devices — camera ↔ companion-device association (first-class
 * device-manager concept).
 *
 * ONE cap read surface (`getLinkedDevices`) resolves the linked set:
 *   - device-tree CHILDREN are ALWAYS included;
 *   - plus the persisted manual list — the operator's picks (D356: nothing
 *     links itself; same-location devices are only SUGGESTED by the picker);
 *   - the camera itself is excluded; the result is deduped.
 *
 * CONTAINERS (`DeviceType.Container` — "parent container for entity-children
 * adopted from a single HA device entry", never renderable standalone, never
 * capability-bearing by construction, see `device-type.ts`) are never a
 * resolved link, in EITHER mode. A container occupies a UI slot and produces
 * no event — the capability always lives on the container's CHILD instead
 * (`getBindings(containerId)` is empty by construction; the child has the
 * cap). Any candidate that resolves to a container is transparently expanded
 * to that container's own children instead of being dropped — this is what
 * lets an operator link "the door lock" when the lock is modelled as a
 * container-with-children device: the always-included children rule and a
 * persisted manual id both funnel through the same expansion
 * (`expandContainer` below), recursively, so a container reached by either
 * path never appears and its real (capability-bearing) descendants do
 * instead. A manually-picked id that names a container is NOT stripped from
 * the persisted `_linkedDeviceIds` config — that would be a write on what is
 * otherwise a read path — it simply now resolves through the same expansion
 * as everything else (to its children, or to nothing if childless). The
 * `linked-devices` extension slot (`device-extension-linked-slot.ts`) never
 * OFFERS a container as a candidate and refuses one as a new pick — it is
 * never a legitimate pick, not just a filtered-out resolution.
 *
 * AUTO mode's same-location match compares each candidate's OWN `location`
 * field directly — no read-time inheritance. (2026-08-26, operator decision,
 * supersedes the read-time `resolveEffectiveLocation` this file used to
 * carry: a container's location-less child does NOT get resolved a location
 * at read time. Instead `setLocation` — device-meta-actions.ts — CASCADES a
 * container's location to every descendant's own `location` column the
 * instant the operator (re)sets it. Since D352 that write-time coverage is
 * complete: a one-shot boot backfill aligned every pre-cascade container
 * (`location-alignment.ts`), and `registerDevice` stamps the nearest located
 * CONTAINER ancestor's location onto a later-adopted child at registration
 * (container-only — a camera's accessories stay location-less on purpose,
 * reachable structurally, so they never become other cameras' companions). A
 * location-less child of a located container is therefore an ANOMALY (a
 * partially-failed cascade, a hand-edited ledger) — still skipped here, a
 * container is never itself a link (file header), full stop. The skip here
 * stays silent — there is no per-read warning in this file — but it is no
 * longer UNREPORTED: `location-alignment.ts`'s boot-time detection re-lists
 * every device on each boot and logs a WARN naming the ancestor and its
 * misaligned descendants, so the anomaly surfaces on a fixed cadence even
 * though no individual read here announces it.
 *
 * CONFIGURATION is the `linked-devices` extension slot (D648): it reads the
 * reserved keys below with `parseLinkedDevicesConfig` and writes them with
 * `applyLinkedDevicesPatch` — the device config blob, the same pattern as
 * `_profileMap`. The hand-written "Linked devices" settings section that
 * wrote the same keys was retired by D655. The one-shot "rebuild this room"
 * action is a CLIENT concern: the Locations page computes the same-location
 * set with `legacyAutoLinkIds` and writes it through the same slot.
 */
import type {
  DeviceInfo,
  IDeviceManagerProvider,
  LinkedDevice,
  LinkedDevicesMode,
} from '@camstack/types'
import { DeviceType } from '@camstack/types'
// The pure linked-set rules live in `@camstack/types` so the hub's boot
// backfill and the admin UI's per-room rebuild share ONE definition of what a
// room contains — see `linked-device-resolve.ts`.
import { expandContainer, legacyAutoLinkIds, type LinkCandidate } from '@camstack/types'
// Re-exported so the existing importers keep their one import site; the
// DEFINITION moved, the surface did not.
export { legacyAutoLinkIds, type LinkCandidate }
import type { ProviderContext } from './device-provider-context.js'
import { listAll } from './device-queries.js'

/** Reserved device-config keys (cf. `_profileMap`). */
export const LINKED_MODE_CONFIG_KEY = '_linkedDevicesMode'
export const LINKED_IDS_CONFIG_KEY = '_linkedDeviceIds'
/** Reserved key: subset of linked devices that materialize synthetic tracked
 *  events on the camera. Absent ⇒ NONE — producing tracked events is an
 *  explicit operator OPT-IN (2026-07-22 flip: the old absent⇒ALL default
 *  auto-materialized sensor snapshots the operator never asked for). */
export const LINKED_TRACKED_IDS_CONFIG_KEY = '_linkedDeviceTrackedIds'

/**
 * The three reserved keys, as one set: they stay with a camera's NUMBER on a
 * hardware swap, and a settings save that still carries them (a page opened
 * before D655 retired the section) is refused by name, never dropped.
 */
export const LINKED_DEVICES_RESERVED_KEYS: ReadonlySet<string> = new Set([
  LINKED_MODE_CONFIG_KEY,
  LINKED_IDS_CONFIG_KEY,
  LINKED_TRACKED_IDS_CONFIG_KEY,
])

export interface LinkedDevicesConfig {
  /** Always `manual` since D356 — kept on the type because the cap output
   *  still carries it for clients already shipped. */
  readonly mode: LinkedDevicesMode
  readonly manualIds: readonly number[]
}

/** Parse the two reserved keys out of a device-config blob. Tolerant:
 *  ids may arrive as numbers or numeric strings (the multiselect field
 *  stores string option values); anything else is dropped. */
export function parseLinkedDevicesConfig(blob: Record<string, unknown>): LinkedDevicesConfig {
  // `_linkedDevicesMode` is no longer read (D356): the operator's list is the
  // only source. The boot backfill wrote `manual` into every camera once, so
  // the key is a fact about history, not an input.
  const mode: LinkedDevicesMode = 'manual'
  const rawIds = blob[LINKED_IDS_CONFIG_KEY]
  const manualIds: number[] = []
  if (Array.isArray(rawIds)) {
    for (const v of rawIds) {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN
      if (Number.isInteger(n) && !manualIds.includes(n)) manualIds.push(n)
    }
  }
  return { mode, manualIds }
}

/**
 * Pure resolution core: children ∪ (auto → same-location | manual → list),
 * minus self, deduped, CONTAINERS expanded to their children (see file
 * header). Order: children first, then mode additions.
 */
export function resolveLinkedDeviceIds(params: {
  readonly selfId: number
  readonly config: LinkedDevicesConfig
  readonly candidates: readonly LinkCandidate[]
}): readonly number[] {
  const { selfId, config, candidates } = params
  const byId = new Map<number, LinkCandidate>(candidates.map((c) => [c.id, c]))
  const byParent = new Map<number, LinkCandidate[]>()
  for (const c of candidates) {
    if (c.parentDeviceId === null) continue
    const siblings = byParent.get(c.parentDeviceId)
    if (siblings) siblings.push(c)
    else byParent.set(c.parentDeviceId, [c])
  }
  const ids = new Set<number>()
  const expand = (id: number): void => expandContainer(id, byId, byParent, new Set(), ids)

  for (const c of candidates) {
    if (c.parentDeviceId === selfId) expand(c.id)
  }
  for (const id of config.manualIds) {
    if (byId.has(id)) expand(id)
  }
  ids.delete(selfId)
  return [...ids]
}

/**
 * Which linked devices materialize synthetic tracked events on the camera.
 * Absent / non-array config key ⇒ NONE — the operator must explicitly pick
 * producers (opt-in; flipped from the legacy absent⇒ALL default, which
 * auto-materialized sensor snapshots for every linked device). Otherwise the
 * configured subset intersected with the currently-resolved linked set (a
 * picked id no longer linked is dropped). Ids may arrive as numbers or numeric
 * strings (the multiselect stores string option values); non-numeric entries
 * are ignored.
 */
export function resolveTrackedEventDeviceIds(
  config: Record<string, unknown>,
  linkedIds: readonly number[],
): readonly number[] {
  const picked = new Set(parseTrackedOptIn(config))
  return linkedIds.filter((id) => picked.has(id))
}

/**
 * The persisted tracked-event opt-in AS STORED — not intersected with the
 * linked set, which is the resolver's job. Absent / non-array ⇒ `[]` (NONE,
 * the same answer the resolver gives). Ids may be numbers or numeric strings;
 * anything else is dropped; deduped, in stored order.
 */
export function parseTrackedOptIn(config: Record<string, unknown>): readonly number[] {
  const raw = config[LINKED_TRACKED_IDS_CONFIG_KEY]
  if (!Array.isArray(raw)) return []
  const out: number[] = []
  for (const v of raw) {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN
    if (Number.isInteger(n) && !out.includes(n)) out.push(n)
  }
  return out
}

/**
 * The fleet listing every function here needs, and the ONLY projection any of
 * them may ask for.
 *
 * Linked-device policy reads five fields off a candidate — `id`,
 * `parentDeviceId`, `location`, `name`, `features` — and `slim` carries all
 * five. What `slim` drops is `config`, and `config` is not a column: `listAll`
 * materialises it with ONE `readDeviceStore` per device, sequentially, on
 * device-manager's event loop. This module asked for the full projection three
 * times, so every linked-devices read swept the whole fleet's settings rows to
 * use none of them.
 *
 * Measured on the live hub 2026-08-25: `query addon-device-settings` ran
 * 36 814 times a minute against a 967-device fleet — ~38 full-fleet sweeps a
 * minute, ~31 of them the `pipeline-analytics` reverse index rebuilding itself
 * one camera at a time through `getLinkedDevices`. The per-camera `config`
 * this query DOES need is the separate `readDeviceStore(deviceId)` below, and
 * it is one row, not the fleet.
 */
export const LINK_CANDIDATE_PROJECTION = { projection: 'slim' } as const

/** The single resolved answer, before it is tagged with its camera. */
export type ResolvedLinkedDevices = Awaited<ReturnType<IDeviceManagerProvider['getLinkedDevices']>>

/**
 * Resolve ONE camera's linked set against an ALREADY-FETCHED fleet.
 *
 * The fleet is a parameter, not a fetch, because it is the entire cost of this
 * query: candidates are "children ∪ same-location", which needs every device.
 * Single-device and batch differ only in how many times that listing is paid
 * for — never in the policy, which lives here and nowhere else.
 */
function resolveFor(
  deviceId: number,
  all: readonly DeviceInfo[],
  byId: ReadonlyMap<number, DeviceInfo>,
  blob: Record<string, unknown>,
): ResolvedLinkedDevices {
  const config = parseLinkedDevicesConfig(blob)
  const ids = resolveLinkedDeviceIds({
    selfId: deviceId,
    config,
    candidates: all,
  })
  const trackedIds = new Set(resolveTrackedEventDeviceIds(blob, ids))
  const devices: LinkedDevice[] = []
  for (const id of ids) {
    const d = byId.get(id)
    if (!d) continue
    devices.push({
      deviceId: d.id,
      name: d.name,
      location: d.location,
      features: d.features,
      producesTrackedEvents: trackedIds.has(d.id),
    })
  }
  return { mode: config.mode, devices }
}

/** Cap implementation of `getLinkedDevices`. */
export async function getLinkedDevices(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['getLinkedDevices']>[0],
): ReturnType<IDeviceManagerProvider['getLinkedDevices']> {
  const { deviceId } = input
  const [all, blob] = await Promise.all([
    listAll(pctx, LINK_CANDIDATE_PROJECTION),
    pctx.settings.readDeviceStore(deviceId),
  ])
  const byId = new Map<number, DeviceInfo>(all.map((d) => [d.id, d]))
  return resolveFor(deviceId, all, byId, blob)
}

/**
 * Cap implementation of `getLinkedDevicesBatch` — ONE fleet listing for the
 * whole set.
 *
 * That listing is the query's cost (see `resolveFor`), and asking per camera
 * does not amortise it: on the live hub 2026-08-25, 30 concurrent
 * `getLinkedDevices` took 4110 ms wall — a queue of thirty full-fleet sweeps
 * on device-manager's event loop — to produce 7260 bytes.
 *
 * Ids are deduped and the answer is one row per REQUESTED id, in the order
 * asked: a camera whose settings read fails still gets a row (resolved against
 * an empty config, i.e. children-only) rather than dropping out of the array.
 */
export async function getLinkedDevicesBatch(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['getLinkedDevicesBatch']>[0],
): ReturnType<IDeviceManagerProvider['getLinkedDevicesBatch']> {
  const deviceIds = [...new Set(input.deviceIds)]
  if (deviceIds.length === 0) return []
  const [all, blobs] = await Promise.all([
    listAll(pctx, LINK_CANDIDATE_PROJECTION),
    Promise.all(
      deviceIds.map((id) =>
        pctx.settings.readDeviceStore(id).catch((err: unknown) => {
          // A settings read that fails is one camera's ASSOCIATION config, not
          // its existence. Degrading to children-only is the same answer the
          // device would give with no linked-devices config written — and it
          // is logged, because a silently children-only camera looks exactly
          // like a correctly-configured one.
          pctx.host.ctx.logger.warn('getLinkedDevicesBatch: settings read failed — children only', {
            tags: { deviceId: id },
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
          return {} as Record<string, unknown>
        }),
      ),
    ),
  ])
  const byId = new Map<number, DeviceInfo>(all.map((d) => [d.id, d]))
  return deviceIds.map((deviceId, index) => {
    return { deviceId, ...resolveFor(deviceId, all, byId, blobs[index] ?? {}) }
  })
}

/** The two device-store calls the linked-devices write needs — nothing else. */
export interface LinkedDevicesStoreAccess {
  readonly settings: Pick<ProviderContext['settings'], 'readDeviceStore' | 'writeDeviceStore'>
}

/**
 * THE write path for the linked-devices keys — the `linked-devices` slot's
 * `set` lands here (D648). Normalizes the pick list and the tracked-event
 * opt-in; an EXPLICIT empty opt-in is stored as `[]`, never deleted, because
 * an absent key and an empty one are read alike today but only `[]` says the
 * operator chose "none".
 */
export async function applyLinkedDevicesPatch(
  pctx: LinkedDevicesStoreAccess,
  deviceId: number,
  patch: Record<string, unknown>,
): Promise<{ success: true }> {
  const current = await pctx.settings.readDeviceStore(deviceId)
  const next: Record<string, unknown> = { ...current }
  if (LINKED_IDS_CONFIG_KEY in patch) {
    next[LINKED_IDS_CONFIG_KEY] = [
      ...parseLinkedDevicesConfig({ [LINKED_IDS_CONFIG_KEY]: patch[LINKED_IDS_CONFIG_KEY] })
        .manualIds,
    ]
  }
  if (LINKED_TRACKED_IDS_CONFIG_KEY in patch) {
    next[LINKED_TRACKED_IDS_CONFIG_KEY] = [...parseTrackedOptIn(patch)]
  }
  await pctx.settings.writeDeviceStore(deviceId, next)
  return { success: true as const }
}

// ── Pick validation (the `linked-devices` extension slot, D648) ──────

/** The one field a pick is judged by. */
export interface LinkedPickDevice {
  readonly type: string
}

/** What `refusedLinkedPicks` judges: the write, and what it is judged against. */
export interface LinkedPicksInput {
  readonly selfId: number
  readonly picked: readonly number[]
  readonly persisted: readonly number[]
  readonly fleet: ReadonlyMap<number, LinkedPickDevice>
}

/** One refused pick, named — the refusal message is built from these. */
export interface LinkedPickRefusal {
  readonly deviceId: number
  readonly reason: 'self' | 'container' | 'unknown'
}

/**
 * Which NEW picks a linked-devices write must refuse: the camera itself, a
 * container (never a pick — its children are, D356 and the file header), and
 * an id no device has.
 *
 * Only ids that are not ALREADY persisted are judged. A list written before
 * this rule existed may hold a container or a device that has since been
 * deleted; the editor shows those as unavailable / missing, and keeping them
 * is not a new link. Removing them is the operator's call, never this
 * function's (a missing source is shown, never silently dropped).
 *
 * Since D655 every write of the list goes through the slot, the Locations
 * page's room rebuild included, so this is the only gate a pick passes.
 */
export function refusedLinkedPicks(params: LinkedPicksInput): readonly LinkedPickRefusal[] {
  const kept = new Set(params.persisted)
  const out: LinkedPickRefusal[] = []
  for (const deviceId of params.picked) {
    if (kept.has(deviceId)) continue
    if (deviceId === params.selfId) {
      out.push({ deviceId, reason: 'self' })
      continue
    }
    const device = params.fleet.get(deviceId)
    if (device === undefined) out.push({ deviceId, reason: 'unknown' })
    else if (device.type === DeviceType.Container) out.push({ deviceId, reason: 'container' })
  }
  return out
}
