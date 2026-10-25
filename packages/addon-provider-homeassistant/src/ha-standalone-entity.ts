import {
  DeviceType,
  EnumSensorDateTimeFormatSchema,
  type DeviceConstructor,
  type DeviceContext,
  type DiscoveredChildDevice,
  type DiscoveredChildStatus,
  type EnumSensorDateTimeFormat,
  type IDevice,
  type SavedDevice,
  type SourceInfo,
} from '@camstack/types'
import { pickHaChildClass } from './ha-child-class-factory.js'
import { readHaSource } from './ha-device-source.js'
import type { HaDeviceSource } from './ha-device-source.js'
import type { HaDiscoveredEntity } from './ha-discovery-types.js'

/**
 * Standalone single-entity import (the HA `'entities'` adoption granularity).
 *
 * Where the `'devices'` granularity materialises one Container parent + N
 * accessory children per HA physical device, the `'entities'` granularity
 * imports ONE HA entity as a TOP-LEVEL standalone CamStack device — no
 * Container. The standalone device reuses the per-domain `HaBaseChildDevice`
 * subclasses (which work parent-less: they read `brokerId`/`entityId` from
 * config and subscribe by that tuple), so live state flows exactly as it does
 * for a container-child.
 *
 * The two import paths are NOT mutually exclusive: a standalone device and a
 * container-child for the same entity coexist; each carries its own broker
 * subscription, so both update on every state push (no de-dupe).
 */

/** A standalone HA entity device's stableId. Collision-free vs the Container's
 *  `ha:<broker>:dev:<haDeviceId>` because the `:entity:` infix differs and an
 *  HA entity id (`switch.kitchen`) is disjoint from an HA device-registry id. */
export function generateStandaloneEntityStableId(brokerId: string, entityId: string): string {
  return `ha:${brokerId}:entity:${entityId}`
}

/**
 * Cap-re-derive dispatcher used as the `DeviceClass` for a standalone entity.
 *
 * The kernel's standalone `create()` captures a rebuild factory that calls
 * `new DeviceClass(ctx)` with the merged config on `applyDerivedSpec`. By
 * passing THIS dispatcher as the class, the rebuild re-reads
 * `config.capabilities` and re-derives the concrete per-domain class via
 * `pickHaChildClass` — so a capability drift (e.g. an entity gaining
 * `brightness`) rebuilds into the correct class, mirroring the container
 * child's `getAccessoryChildren().factory` re-derive.
 *
 * A JS constructor that returns an object replaces the `new` result, so
 * `new HaStandaloneEntityDevice(ctx)` yields a real `HaSwitchDevice` /
 * `HaLightDevice` / … instance. TS types the class's `new` as its own
 * (member-less) instance, so `standaloneEntityDeviceClass` carries a single
 * documented `DeviceConstructor<IDevice>` boundary cast (CLAUDE.md sanctions
 * documented type-boundary `as X`; this is NOT an `as unknown as` widening —
 * the runtime construct-return genuinely IS an `IDevice`).
 * `instanceof HaStandaloneEntityDevice` is always false — it is a dispatch
 * shim, never a real instance type.
 */
// eslint-disable-next-line typescript/no-extraneous-class -- this constructor-only class is intentional: it is passed as a `DeviceConstructor` and instantiated via `new`, using the JS constructor-returns-object trick to dispatch to the concrete per-domain device class. A standalone function cannot replace it (the kernel calls `new DeviceClass(ctx)`).
class HaStandaloneEntityDevice {
  constructor(ctx: DeviceContext) {
    const caps = readCapabilities(ctx.persistedConfig)
    const Klass = pickHaChildClass(caps)
    // A constructor returning an object replaces the `new` result: the produced
    // instance IS the per-domain IDevice.
    return new Klass(ctx)
  }
}

/** Read the `capabilities` string array from a persisted config blob. */
function readCapabilities(config: Record<string, unknown> | undefined): readonly string[] {
  const raw = config?.['capabilities']
  if (!Array.isArray(raw)) return []
  return raw.filter((c): c is string => typeof c === 'string')
}

/**
 * Build the persisted config blob for a standalone entity device. Mirrors the
 * per-entity fields the container persists on its `entities[]` entries (so the
 * `HaBaseChildDevice` subclasses self-hydrate identically), plus the
 * `system`/`brokerId`/`integrationId` adoption-proof fields that `readHaSource`
 * recognises. Entities with no CamStack mapping cannot be imported standalone
 * (the caller skips them) — `mappedTo` is required here.
 */
export function buildStandaloneEntityConfig(args: {
  entity: HaDiscoveredEntity
  brokerId: string
  integrationId?: string
  name?: string
}): Record<string, unknown> {
  const { entity, brokerId, integrationId, name } = args
  if (entity.mappedTo === null) {
    throw new Error(
      `buildStandaloneEntityConfig: entity '${entity.entityId}' has no CamStack mapping`,
    )
  }
  const mapping = entity.mappedTo
  return {
    system: 'homeassistant',
    brokerId,
    entityId: entity.entityId,
    capabilities: [...mapping.capabilities],
    ...(mapping.role !== null ? { role: mapping.role } : {}),
    ...(entity.unitOfMeasurement !== null ? { unitOfMeasurement: entity.unitOfMeasurement } : {}),
    ...(entity.deviceClass !== null ? { deviceClass: entity.deviceClass } : {}),
    ...(entity.options !== null ? { options: entity.options } : {}),
    ...(mapping.features !== undefined && mapping.features.length > 0
      ? { features: [...mapping.features] }
      : {}),
    ...(mapping.dateTimeFormat !== undefined ? { dateTimeFormat: mapping.dateTimeFormat } : {}),
    ...(integrationId !== undefined ? { integrationId } : {}),
    name: name ?? entity.name,
  }
}

/**
 * Map an `HaDiscoveredEntity` onto the shared `DiscoveredChildDevice` for the
 * `'entities'` granularity: a FLAT candidate (no `children`) whose
 * `childNativeId` is the entity id. Entities with no mapping are excluded by
 * the caller (this fn falls back to `Generic` defensively). `alreadyAdopted`
 * here means a STANDALONE device for this entity already exists.
 */
export function entityToStandaloneCandidate(
  entity: HaDiscoveredEntity,
  alreadyAdopted: boolean,
): DiscoveredChildDevice {
  const sourceInfo: SourceInfo = { id: entity.entityId, system: 'homeassistant' }
  return {
    childNativeId: entity.entityId,
    name: entity.name,
    type: entity.mappedTo?.deviceType ?? DeviceType.Generic,
    status: entityStatus(entity.state),
    metadata: entity.area !== null ? { externalLocation: entity.area } : {},
    alreadyAdopted,
    adoptedDeviceId: null,
    capabilities: entity.mappedTo ? [...entity.mappedTo.capabilities] : [],
    sourceInfo,
  }
}

/**
 * Flatten every HA device's entities into the flat `'entities'`-granularity
 * candidate list. Entities with no CamStack mapping are skipped (they cannot
 * be imported as a standalone device). `adoptedEntityIds` is the set of
 * entityIds that already have a STANDALONE device — those are marked
 * `alreadyAdopted` (a container-child for the same entity does NOT count).
 */
export function buildStandaloneEntityCandidates(
  haDevices: readonly { entities: readonly HaDiscoveredEntity[] }[],
  adoptedEntityIds: ReadonlySet<string>,
): DiscoveredChildDevice[] {
  const out: DiscoveredChildDevice[] = []
  for (const dev of haDevices) {
    for (const ent of dev.entities) {
      if (ent.mappedTo === null) continue
      out.push(entityToStandaloneCandidate(ent, adoptedEntityIds.has(ent.entityId)))
    }
  }
  return out
}

/** Mirror of `ha-candidate-mapper`'s entity reachability decode. */
function entityStatus(state: string): DiscoveredChildStatus {
  if (state === 'unavailable') return 'offline'
  if (state === '' || state === 'unknown') return 'unknown'
  return 'online'
}

/**
 * True when a persisted device row is a STANDALONE HA entity device — the boot
 * `restoreDevices` branch that re-instantiates it via the cap-re-derive
 * dispatcher (rather than the default `deviceClasses[type]` lookup, which only
 * knows the Container).
 *
 * Shape (mirrors the `adopt('entities')` create path): a top-level
 * (`parentDeviceId === null`) HA-adopted device (`readHaSource` non-null) whose
 * source carries an `entityId` and NO `haDeviceId`. The Container path carries
 * `haDeviceId`; its accessory children carry a parent — both are excluded.
 */
export function isStandaloneEntitySaved(saved: SavedDevice): boolean {
  if (saved.parentDeviceId !== null) return false
  const source = readHaSource(saved.config)
  if (source === null) return false
  if (source.haDeviceId !== undefined) return false
  return source.entityId !== undefined
}

/**
 * True when a persisted device row is an HA Container ACCESSORY-CHILD (one
 * entity of a physical HA device, spawned under its `HaContainerDevice` parent
 * via `getAccessoryChildren`). Such a row carries a `parentDeviceId`, an
 * `entityId` in its source, and NO `haDeviceId` (only the Container carries
 * `haDeviceId`).
 *
 * These children are NOT restored by the default `BaseDeviceProvider`
 * two-pass: Pass 2 only re-instantiates rows whose `type` is in
 * `deviceClasses`, and an entity child's type (Switch / Cover / …) is NOT in
 * that map — so the default pass cleanly skips it and the parent Container's
 * `getAccessoryChildren()` + the kernel's accessory-spawn rebuild it instead.
 *
 * The one type that IS in `deviceClasses` is `EventEmitter`, mapped to the
 * Case-2 per-broker aggregator `HaEventBusDevice`. Without excluding these
 * rows, Pass 2 would MIS-INSTANTIATE an EventEmitter entity child as the
 * aggregator (whose `kind:'event-bus'` schema rejects the entity-child config
 * → "Failed to restore hub-adopted child"). Excluding every entity-backed
 * child here routes them all uniformly through the Container reconcile,
 * exactly like switch / cover children — leaving ONLY the top-level aggregator
 * (no parent, no entityId, `kind:'event-bus'`) on the `deviceClasses` path.
 */
export function isContainerEntityChildSaved(saved: SavedDevice): boolean {
  if (saved.parentDeviceId === null) return false
  const source = readHaSource(saved.config)
  if (source === null) return false
  if (source.haDeviceId !== undefined) return false
  return source.entityId !== undefined
}

/** Partition persisted rows for the HA restore into three buckets:
 *
 *  - `standalone`: top-level entity devices (the `entities` granularity),
 *    restored via the cap-re-derive dispatcher.
 *  - `containerChildren`: HA Container accessory children (one entity per
 *    physical device), OWNED by the parent Container's `getAccessoryChildren()`
 *    + the kernel's accessory-spawn — NOT the default two-pass. Excluding them
 *    keeps an `EventEmitter` entity child from being mis-instantiated as the
 *    Case-2 aggregator (`deviceClasses[EventEmitter] = HaEventBusDevice`), and
 *    keeps the default pass from logging a spurious warning on the others.
 *  - `rest`: everything else (Container parents + the top-level event-bus
 *    aggregator), restored by `BaseDeviceProvider.onRestoreDevices`. */
export function partitionRestoreDevices(savedDevices: readonly SavedDevice[]): {
  standalone: readonly SavedDevice[]
  containerChildren: readonly SavedDevice[]
  rest: readonly SavedDevice[]
} {
  const standalone: SavedDevice[] = []
  const containerChildren: SavedDevice[] = []
  const rest: SavedDevice[] = []
  for (const saved of savedDevices) {
    if (isStandaloneEntitySaved(saved)) standalone.push(saved)
    else if (isContainerEntityChildSaved(saved)) containerChildren.push(saved)
    else rest.push(saved)
  }
  return { standalone, containerChildren, rest }
}

/**
 * The cap-re-derive dispatcher as a `DeviceConstructor<IDevice>` for
 * `kernel.devices.create`. The dispatcher's constructor returns the per-domain
 * `IDevice` at runtime; TS types the class's `new` as its own member-less
 * instance, so this is the single documented type-boundary cast for the
 * dispatch shim (CLAUDE.md-sanctioned `as X`, not an `as unknown as` widening).
 */
export const standaloneEntityDeviceClass = HaStandaloneEntityDevice as DeviceConstructor<IDevice>

// ── Re-sync (capability / class drift) ───────────────────────────────────────

/**
 * The class-affecting + persist-affecting projection of a standalone entity
 * device, used to detect CAPABILITY/CLASS drift between the persisted device and
 * the live HA inventory. `type`/`role` come from the device meta; the rest are
 * mapping-derived config fields. Mirrors `HaContainerEntityConfig` minus the
 * `entityId`/`name` (name is cosmetic, never triggers a rebuild — like the
 * Container reconcile, see `derivedKey`).
 */
export interface StandaloneEntitySpec {
  type: DeviceType
  role?: string
  capabilities: readonly string[]
  unitOfMeasurement?: string
  deviceClass?: string
  options?: readonly string[]
  features?: readonly string[]
  /** Locale-render shape for a `DateTimeSensor`-role enum sensor — seeded into
   *  the cap slice by the device so the UI renders the ISO `value` formatted. */
  dateTimeFormat?: EnumSensorDateTimeFormat
}

/** A mapping-derived change to push onto a live standalone device via the
 *  generic `applyDerivedSpec` primitive. `changed === false` → no drift, no
 *  call. `role` is retained on the type for callers but is never populated —
 *  Role is operator-owned after adopt and must not be re-derived on drift. */
export interface StandaloneEntityDiff {
  changed: boolean
  type?: DeviceType
  /** @deprecated Never set — Role is operator-owned after adopt. */
  role?: string
  /** Config patch (the class-affecting fields). Merged over the device's
   *  persisted config; a capabilities change drives the class rebuild via the
   *  captured cap-re-derive factory. `brokerId`/`entityId` are stable and
   *  intentionally omitted. Role is never included. */
  config?: Record<string, unknown>
}

/**
 * Project a LIVE persisted standalone device onto its `StandaloneEntitySpec`.
 * `type`/`role` from the device meta; capabilities + mapping-derived fields from
 * the HA source projection (the same blob `adopt`/restore persist).
 */
export function readPersistedStandaloneSpec(device: IDevice): StandaloneEntitySpec {
  const config = snapshotDeviceConfig(device)
  const source = readHaSource(config)
  const dateTimeFormat = readDateTimeFormat(config)
  return {
    type: device.type,
    ...(device.role !== undefined ? { role: device.role } : {}),
    capabilities: source?.capabilities ?? [],
    ...(source?.unitOfMeasurement !== undefined
      ? { unitOfMeasurement: source.unitOfMeasurement }
      : {}),
    ...(source?.deviceClass !== undefined ? { deviceClass: source.deviceClass } : {}),
    ...(source?.options !== undefined ? { options: source.options } : {}),
    ...(source?.features !== undefined ? { features: source.features } : {}),
    ...(dateTimeFormat !== undefined ? { dateTimeFormat } : {}),
  }
}

/** Read + validate the `dateTimeFormat` field from a persisted config blob.
 *  `readHaSource` does not carry it (it is an enum-sensor render hint, not an
 *  adoption-proof source field), so it is projected directly here, mirroring the
 *  Container's `EnumSensorDateTimeFormatSchema.safeParse` guard. */
function readDateTimeFormat(config: Record<string, unknown>): EnumSensorDateTimeFormat | undefined {
  const parsed = EnumSensorDateTimeFormatSchema.safeParse(config['dateTimeFormat'])
  return parsed.success ? parsed.data : undefined
}

/** Flatten a live device's config into a plain blob for `readHaSource`. */
function snapshotDeviceConfig(device: IDevice): Record<string, unknown> {
  const blob: Record<string, unknown> = {}
  for (const entry of device.config.entries()) {
    blob[entry.key] = entry.value
  }
  return blob
}

/**
 * Build the FRESH `StandaloneEntitySpec` for an entity from the live HA
 * inventory. `type` is the mapping's `deviceType`; the config fields are derived
 * by reusing {@link buildStandaloneEntityConfig} (single source of truth for the
 * persisted shape) and re-projecting via `readHaSource` so the comparison runs
 * against the same normalisation the persisted side went through.
 */
export function buildFreshStandaloneSpec(entity: HaDiscoveredEntity): StandaloneEntitySpec {
  if (entity.mappedTo === null) {
    throw new Error(`buildFreshStandaloneSpec: entity '${entity.entityId}' has no CamStack mapping`)
  }
  const config = buildStandaloneEntityConfig({ entity, brokerId: 'reconcile' })
  const source = readHaSource(config)
  const dateTimeFormat = readDateTimeFormat(config)
  return {
    type: entity.mappedTo.deviceType,
    ...(source?.role !== undefined ? { role: source.role } : {}),
    capabilities: source?.capabilities ?? [...entity.mappedTo.capabilities],
    ...(source?.unitOfMeasurement !== undefined
      ? { unitOfMeasurement: source.unitOfMeasurement }
      : {}),
    ...(source?.deviceClass !== undefined ? { deviceClass: source.deviceClass } : {}),
    ...(source?.options !== undefined ? { options: source.options } : {}),
    ...(source?.features !== undefined ? { features: source.features } : {}),
    ...(dateTimeFormat !== undefined ? { dateTimeFormat } : {}),
  }
}

/** Stable key over the class-affecting fields — drives the drift decision.
 *  Excludes `type` (compared directly) but folds it in so a pure type change
 *  (same caps, different DeviceType — shouldn't happen but defensively safe)
 *  still counts. **Role is deliberately omitted**: after adopt, Role is
 *  operator-owned (`setRole` in the UI). Including it here made every mapping
 *  / capability drift re-push the derived role via `applyDerivedSpec` and
 *  revert the Role select by itself.
 */
function standaloneDerivedKey(s: StandaloneEntitySpec): string {
  return JSON.stringify({
    type: s.type,
    capabilities: [...s.capabilities],
    unitOfMeasurement: s.unitOfMeasurement ?? null,
    deviceClass: s.deviceClass ?? null,
    options: s.options ?? null,
    features: s.features ?? null,
    dateTimeFormat: s.dateTimeFormat ?? null,
  })
}

/** The config patch pushed via `applyDerivedSpec` on drift — the class-affecting
 *  fields only (mirrors the Container reconcile's `childConfigPatch`), minus
 *  `role` which is operator-owned after adopt and must not be clobbered. */
function standaloneConfigPatch(s: StandaloneEntitySpec): Record<string, unknown> {
  return {
    capabilities: [...s.capabilities],
    ...(s.unitOfMeasurement !== undefined ? { unitOfMeasurement: s.unitOfMeasurement } : {}),
    ...(s.deviceClass !== undefined ? { deviceClass: s.deviceClass } : {}),
    ...(s.options !== undefined ? { options: [...s.options] } : {}),
    ...(s.features !== undefined ? { features: [...s.features] } : {}),
    ...(s.dateTimeFormat !== undefined ? { dateTimeFormat: s.dateTimeFormat } : {}),
  }
}

/**
 * Diff a persisted standalone entity device against the fresh HA mapping. Pure —
 * no I/O. On drift the caller pushes `{ type, config }` through
 * `kernel.devices.applyDerivedSpec(deviceId, …)`; the captured cap-re-derive
 * factory rebuilds the concrete per-domain class from the new `capabilities`.
 * Role is never part of the patch — it is operator-owned after adopt.
 */
export function diffStandaloneEntity(
  persisted: StandaloneEntitySpec,
  fresh: StandaloneEntitySpec,
): StandaloneEntityDiff {
  if (standaloneDerivedKey(persisted) === standaloneDerivedKey(fresh)) {
    return { changed: false }
  }
  return {
    changed: true,
    type: fresh.type,
    config: standaloneConfigPatch(fresh),
  }
}

/**
 * True when a LIVE registry device is a STANDALONE HA entity device for
 * `brokerId` — the re-sync sweep's enumeration predicate. Mirrors
 * {@link isStandaloneEntitySaved} (the persisted-row form) for the live
 * `IDevice` shape: top-level (`parentDeviceId === null`), HA-adopted
 * (`readHaSource` non-null), source carries an `entityId`, NO `haDeviceId`, and
 * `brokerId` matches. Container parents (carry `haDeviceId`) + accessory
 * children (carry a parent) + non-HA + other-broker devices are excluded.
 */
export function isStandaloneEntityDevice(device: IDevice, brokerId: string): boolean {
  if (device.parentDeviceId !== null) return false
  const source: HaDeviceSource | null = readHaSource(snapshotDeviceConfig(device))
  if (source === null) return false
  if (source.brokerId !== brokerId) return false
  if (source.haDeviceId !== undefined) return false
  return source.entityId !== undefined
}

/** The HA `entityId` of a standalone entity device, or `null` when the device is
 *  not a standalone entity device (no source / no entityId). */
export function standaloneEntityId(device: IDevice): string | null {
  const source = readHaSource(snapshotDeviceConfig(device))
  return source?.entityId ?? null
}

/** One drifted standalone device to rebuild via `applyDerivedSpec`. */
export interface StandaloneReconcileAction {
  deviceId: number
  type?: DeviceType
  role?: string
  config?: Record<string, unknown>
}

/**
 * Pure re-sync planner. Given the broker's live registry `devices` and the
 * FRESH entity inventory (by entityId), enumerate the broker's STANDALONE entity
 * devices and produce one `applyDerivedSpec` action per device whose
 * capability/class drifted. Role is never re-derived (operator-owned). No I/O.
 *
 *   - Non-standalone / other-broker / Container / accessory-child devices →
 *     skipped (via {@link isStandaloneEntityDevice}).
 *   - Entity no longer present (or unmapped) in HA → SKIPPED (left in place;
 *     standalone devices are operator-owned, never auto-removed — there is no
 *     membership concept like a Container's children).
 *   - No drift → no action.
 */
export function planStandaloneReconcile(
  devices: readonly IDevice[],
  freshById: ReadonlyMap<string, HaDiscoveredEntity>,
  brokerId: string,
): StandaloneReconcileAction[] {
  const actions: StandaloneReconcileAction[] = []
  for (const device of devices) {
    if (!isStandaloneEntityDevice(device, brokerId)) continue
    const entityId = standaloneEntityId(device)
    if (entityId === null) continue
    const fresh = freshById.get(entityId)
    if (fresh === undefined || fresh.mappedTo === null) continue // gone / unmapped — leave in place
    const diff = diffStandaloneEntity(
      readPersistedStandaloneSpec(device),
      buildFreshStandaloneSpec(fresh),
    )
    if (!diff.changed) continue
    actions.push({
      deviceId: device.id,
      ...(diff.type !== undefined ? { type: diff.type } : {}),
      ...(diff.config !== undefined ? { config: diff.config } : {}),
    })
  }
  return actions
}
