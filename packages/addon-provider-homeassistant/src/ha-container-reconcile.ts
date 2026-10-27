import { z } from 'zod'
import {
  DeviceType,
  EnumSensorDateTimeFormatSchema,
  type ChildLayout,
  type ChildLayoutEntry,
  type EnumSensorDateTimeFormat,
} from '@camstack/types'
import type { HaDiscoveredDevice, HaEntityCategory } from './ha-discovery-types.js'
import { foldMeterEntities, type MeterEntities } from './ha-meter-fold.js'

/**
 * One entry in an {@link HaContainerDevice}'s persisted `entities[]` config —
 * the mapping-derived shape consumed by `getAccessoryChildren()`. Mirrors the
 * `haEntitySchema` in `ha-container-device.ts`.
 */
export interface HaContainerEntityConfig {
  entityId: string
  deviceType: DeviceType
  capabilities: string[]
  role?: string
  unitOfMeasurement?: string
  deviceClass?: string
  options?: string[]
  features?: string[]
  name?: string
  /** Locale-render shape for a `DateTimeSensor`-role enum sensor — seeded into
   *  the cap slice by the child so the UI renders the ISO `value` formatted. */
  dateTimeFormat?: EnumSensorDateTimeFormat
  /** HA `entity_category` — `config` / `diagnostic` / absent (= a normal
   *  control). Drives the accordion section the child renders in. */
  entityCategory?: HaEntityCategory
  /** Power / energy / voltage / current sensors of the same HA device whose
   *  readings this entity carries as its own `power-meter` (D951). */
  meterEntities?: MeterEntities
  /** The entity this meter sensor is folded into. The sensor stays a child
   *  (D865) but is sectioned as Diagnostic. */
  foldedInto?: string
}

/** Mapping-derived change to push onto a single live accessory child via the
 *  generic `DeviceManagerApi.applyDerivedSpec` primitive. */
export interface ChildDerivedChange {
  entityId: string
  type: DeviceType
  role?: string
  /** Child config patch (capabilities + the optional mapping-derived fields).
   *  Merged over the child's persisted config; a capabilities change drives the
   *  class rebuild. brokerId/entityId are stable and intentionally omitted. */
  config: Record<string, unknown>
}

/** Result of diffing a Container's persisted entities against a fresh HA map. */
export interface ContainerReconcilePlan {
  /** Persisted `entities[]` differs from fresh in ANY field (incl. name / set
   *  membership) → persist the new list. */
  entitiesChanged: boolean
  /** The set of entityIds changed (one added or removed) → the Container must
   *  reprobe so `getAccessoryChildren` spawns new children + removes orphans.
   *  A pure field/name change on the same set does NOT need a reprobe. */
  membershipChanged: boolean
  /** The new `entities[]` to persist on the Container. */
  freshEntities: HaContainerEntityConfig[]
  /** Existing entities whose mapping-derived (class-affecting) fields changed —
   *  each needs its live child rebuilt via `applyDerivedSpec`. Excludes brand-new
   *  entities (handled by reprobe/spawn) and pure name changes. */
  changedChildren: ChildDerivedChange[]
}

/** Validates a persisted Container `entities[]` blob (mirrors `haEntitySchema`
 *  in ha-container-device.ts). Returns `[]` on absent/invalid input. */
const containerEntitySchema = z.object({
  entityId: z.string(),
  deviceType: z.enum(DeviceType),
  capabilities: z.array(z.string()),
  role: z.string().optional(),
  unitOfMeasurement: z.string().optional(),
  deviceClass: z.string().optional(),
  options: z.array(z.string()).optional(),
  features: z.array(z.string()).optional(),
  name: z.string().optional(),
  dateTimeFormat: EnumSensorDateTimeFormatSchema.optional(),
  entityCategory: z.enum(['config', 'diagnostic']).optional(),
  meterEntities: z
    .object({
      power: z.string().optional(),
      energy: z.string().optional(),
      voltage: z.string().optional(),
      current: z.string().optional(),
    })
    .optional(),
  foldedInto: z.string().optional(),
})

export function parseContainerEntities(raw: unknown): HaContainerEntityConfig[] {
  const result = z.array(containerEntitySchema).safeParse(raw)
  return result.success ? result.data : []
}

/**
 * Build the Container `entities[]` config from a freshly-fetched HA device.
 * Single source of truth shared by the adoption path and reconcile so the two
 * always agree on the persisted shape. Entities with no CamStack mapping are
 * skipped (the adoption path skips them too).
 */
export function buildContainerEntities(haDevice: HaDiscoveredDevice): HaContainerEntityConfig[] {
  return foldMeterEntities(mapContainerEntities(haDevice))
}

function mapContainerEntities(haDevice: HaDiscoveredDevice): HaContainerEntityConfig[] {
  const out: HaContainerEntityConfig[] = []
  for (const ent of haDevice.entities) {
    if (ent.mappedTo === null) continue
    out.push({
      entityId: ent.entityId,
      deviceType: ent.mappedTo.deviceType,
      capabilities: [...ent.mappedTo.capabilities],
      ...(ent.mappedTo.role !== null ? { role: ent.mappedTo.role } : {}),
      ...(ent.unitOfMeasurement !== null ? { unitOfMeasurement: ent.unitOfMeasurement } : {}),
      ...(ent.deviceClass !== null ? { deviceClass: ent.deviceClass } : {}),
      ...(ent.options !== null ? { options: ent.options } : {}),
      ...(ent.mappedTo.features !== undefined && ent.mappedTo.features.length > 0
        ? { features: [...ent.mappedTo.features] }
        : {}),
      ...(ent.mappedTo.dateTimeFormat !== undefined
        ? { dateTimeFormat: ent.mappedTo.dateTimeFormat }
        : {}),
      ...(ent.entityCategory !== null ? { entityCategory: ent.entityCategory } : {}),
      name: ent.name,
    })
  }
  return out
}

/** Stable key over the class-affecting (mapping-derived) fields — excludes
 *  `name`, which is cosmetic and never triggers a child rebuild. */
function derivedKey(e: HaContainerEntityConfig): string {
  return JSON.stringify({
    deviceType: e.deviceType,
    role: e.role ?? null,
    capabilities: e.capabilities,
    unitOfMeasurement: e.unitOfMeasurement ?? null,
    deviceClass: e.deviceClass ?? null,
    options: e.options ?? null,
    features: e.features ?? null,
    dateTimeFormat: e.dateTimeFormat ?? null,
    meterEntities: e.meterEntities ?? null,
  })
}

/** Stable key over the FULL entry incl. name + entityId + the layout-affecting
 *  field (category) — drives the persist decision. A name-only or section-only
 *  change still updates the stored config (and thus the derived `childLayout`),
 *  but does NOT trigger a child-class rebuild (those fields are excluded from
 *  {@link derivedKey}). */
function fullKey(e: HaContainerEntityConfig): string {
  return JSON.stringify({
    entityId: e.entityId,
    name: e.name ?? null,
    entityCategory: e.entityCategory ?? null,
    foldedInto: e.foldedInto ?? null,
    derived: derivedKey(e),
  })
}

function childConfigPatch(e: HaContainerEntityConfig): Record<string, unknown> {
  return {
    capabilities: e.capabilities,
    ...(e.unitOfMeasurement !== undefined ? { unitOfMeasurement: e.unitOfMeasurement } : {}),
    ...(e.deviceClass !== undefined ? { deviceClass: e.deviceClass } : {}),
    ...(e.options !== undefined ? { options: e.options } : {}),
    ...(e.features !== undefined ? { features: e.features } : {}),
    ...(e.dateTimeFormat !== undefined ? { dateTimeFormat: e.dateTimeFormat } : {}),
    ...(e.meterEntities !== undefined ? { meterEntities: e.meterEntities } : {}),
    ...(e.role !== undefined ? { role: e.role } : {}),
  }
}

/**
 * Diff a Container's persisted entities against the freshly-mapped HA entities
 * and produce a reconcile plan. Pure — no I/O. The caller persists
 * `freshEntities` when `entitiesChanged`, rebuilds each `changedChildren` entry
 * via `applyDerivedSpec`, and reprobes the Container to handle add/remove.
 */
export function diffContainerEntities(
  persisted: readonly HaContainerEntityConfig[],
  fresh: readonly HaContainerEntityConfig[],
): ContainerReconcilePlan {
  const persistedById = new Map(persisted.map((e) => [e.entityId, e]))

  const changedChildren: ChildDerivedChange[] = []
  for (const f of fresh) {
    const prev = persistedById.get(f.entityId)
    if (prev === undefined) continue // brand-new entity — reprobe/spawn handles it
    if (derivedKey(prev) === derivedKey(f)) continue
    changedChildren.push({
      entityId: f.entityId,
      type: f.deviceType,
      ...(f.role !== undefined ? { role: f.role } : {}),
      config: childConfigPatch(f),
    })
  }

  const persistedKeys = persisted.map(fullKey).toSorted()
  const freshKeys = fresh.map(fullKey).toSorted()
  const entitiesChanged =
    persistedKeys.length !== freshKeys.length || persistedKeys.some((k, i) => k !== freshKeys[i])

  const persistedIds = new Set(persisted.map((e) => e.entityId))
  const freshIds = new Set(fresh.map((e) => e.entityId))
  const membershipChanged =
    persistedIds.size !== freshIds.size || [...freshIds].some((id) => !persistedIds.has(id))

  return { entitiesChanged, membershipChanged, freshEntities: [...fresh], changedChildren }
}

/** Accordion section titles for HA container children. Uses HA's own
 *  `entity_category` nomenclature so the operator sees familiar groupings. */
const SECTION_CONTROLS = 'Controls'
const SECTION_CONFIGURATION = 'Configuration'
const SECTION_DIAGNOSTIC = 'Diagnostic'

/** Section emit order — `groupChildrenByLayout` renders sections in first-seen
 *  order, so the layout array must be ordered Controls → Configuration →
 *  Diagnostic. Lower rank emits first. */
const SECTION_RANK: Readonly<Record<string, number>> = {
  [SECTION_CONTROLS]: 0,
  [SECTION_CONFIGURATION]: 1,
  [SECTION_DIAGNOSTIC]: 2,
}

/** Resolve the accordion section for one container entity from its HA
 *  `entity_category` (config → Configuration, diagnostic → Diagnostic, else a
 *  normal control). */
function sectionForEntity(e: HaContainerEntityConfig): string {
  if (e.entityCategory === 'config') return SECTION_CONFIGURATION
  if (e.entityCategory === 'diagnostic' || e.foldedInto !== undefined) return SECTION_DIAGNOSTIC
  return SECTION_CONTROLS
}

/**
 * Derive a container `ChildLayout` from its persisted entities. Pure +
 * unit-testable. Each child's `childKey` is its `entityId` (= the accessory
 * `stableIdSuffix` `getAccessoryChildren` assigns). Entities are grouped by HA
 * `entity_category` into named accordion sections.
 *
 * The array is emitted in section order (Controls → Configuration →
 * Diagnostic), and `order` is set per-entry to preserve a stable intra-section
 * ordering matching the input order.
 */
export function deriveChildLayout(entities: readonly HaContainerEntityConfig[]): ChildLayout {
  const decorated = entities.map((e, index) => ({ entity: e, index, section: sectionForEntity(e) }))
  decorated.sort((a, b) => {
    const rankDelta = (SECTION_RANK[a.section] ?? 0) - (SECTION_RANK[b.section] ?? 0)
    return rankDelta !== 0 ? rankDelta : a.index - b.index
  })
  return decorated.map(
    ({ entity, index, section }): ChildLayoutEntry => ({
      childKey: entity.entityId,
      section,
      // `order` is the original input index (not a per-section/zero-based counter):
      // only the RELATIVE ascending order within a section matters to the consumer,
      // so cross-section gaps in the value are fine.
      order: index,
    }),
  )
}
