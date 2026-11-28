import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  DeviceRole,
  DeviceType,
  type ReadingQuantity,
  StoredDeviceTypeSchema,
} from '@dominevo/types'
import { knownArrayCapacityBytes } from './unraid-array-capacity.js'
import type { UnraidArrayDiskInfo, UnraidSnapshot } from './unraid-client-contract.js'

/**
 * Pure snapshot → entity-descriptor mapping. NO I/O — unit-testable in
 * isolation. One {@link UnraidSnapshot} produces a flat list of
 * {@link UnraidEntityDescriptor}s (identity + routing + live value). The Hub
 * persists the IDENTITY subset (via {@link entityIdentity}) on the instance
 * Container's `entities[]`; the entity children re-run this same function on
 * every snapshot and match their descriptor by `key`, so the persisted list and
 * the live values always line up on the same key space.
 *
 * Coverage: array metrics + array binaries + array buttons + per-disk usage/health
 * (from the array member slots) + the notifications event. Docker containers and VMs are
 * NOT entities of the server: each is its own adoptable device (`unraid-discovery.ts`).
 */

/** The seven entity shapes a generic child device is keyed on. */
export const UnraidEntityKindSchema = z.enum([
  'numeric',
  'temperature',
  'enum',
  'binary',
  'switch',
  'button',
  'event',
])
export type UnraidEntityKind = z.infer<typeof UnraidEntityKindSchema>

/** A button's dispatch action — resolved to a live client call on `press`. */
export const UnraidButtonActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start-array') }),
  z.object({ type: z.literal('stop-array') }),
  z.object({ type: z.literal('start-parity') }),
  z.object({ type: z.literal('stop-parity') }),
  /**
   * Read-only: rows persisted before containers became their own devices carry it. The
   * mapping no longer emits it; the instance's next entity reconcile prunes those rows.
   */
  z.object({ type: z.literal('restart-container'), containerId: z.string().min(1) }),
])
export type UnraidButtonAction = z.infer<typeof UnraidButtonActionSchema>

/**
 * The persisted IDENTITY subset of an entity — enough for the Container to spawn
 * the child and for the child to register the right cap + route commands. Live
 * values are NOT persisted (re-derived from the snapshot on each tick).
 */
export const UnraidEntityIdentitySchema = z.object({
  /** Stable, filesystem-safe key (unique per instance, stable across reboots). */
  key: z.string().min(1),
  kind: UnraidEntityKindSchema,
  /** The Dominevo capability the child registers for this kind. */
  capName: z.string().min(1),
  /** The DeviceType the child is created as. */
  deviceType: StoredDeviceTypeSchema,
  /** Operator-facing name. */
  name: z.string().min(1),
  /** Semantic role (icon hint), when one clarifies the entity. */
  role: z.enum(DeviceRole).optional(),
  /** Docker container id — read-only, on rows persisted before containers became devices. */
  containerId: z.string().optional(),
  /** Button dispatch action — present on `button` entities. */
  action: UnraidButtonActionSchema.optional(),
})
export type UnraidEntityIdentity = z.infer<typeof UnraidEntityIdentitySchema>

/** A live numeric reading carried on a `numeric` descriptor. */
export interface UnraidNumericValue {
  /** `null` is an unknown reading (a failed sample), never 0. */
  readonly value: number | null
  /** Quantity the value is already stored in (base unit). */
  readonly quantity: ReadingQuantity
}

/**
 * A full entity descriptor — the identity subset PLUS the live value union for
 * the current snapshot. Only the field matching `kind` is populated.
 */
export interface UnraidEntityDescriptor extends UnraidEntityIdentity {
  /** `numeric` kind. */
  readonly numeric?: UnraidNumericValue
  /** `temperature` kind (Celsius). */
  readonly celsius?: number
  /** `enum` kind. */
  readonly enumValue?: string
  /** `binary` kind (`true` == the reported condition, e.g. a health problem). */
  readonly binary?: boolean
  /** `switch` kind (`true` == on / running). */
  readonly switchOn?: boolean
}

/** Strip the live-value union off a descriptor, leaving the persisted identity. */
export function entityIdentity(descriptor: UnraidEntityDescriptor): UnraidEntityIdentity {
  return {
    key: descriptor.key,
    kind: descriptor.kind,
    capName: descriptor.capName,
    deviceType: descriptor.deviceType,
    name: descriptor.name,
    ...(descriptor.role !== undefined ? { role: descriptor.role } : {}),
    ...(descriptor.containerId !== undefined ? { containerId: descriptor.containerId } : {}),
    ...(descriptor.action !== undefined ? { action: descriptor.action } : {}),
  }
}

/** Longest slug a key carries before it is cut and given a hash of the full id. */
const MAX_SLUG_LENGTH = 48
/** Length of the stable hash suffix that keeps a cut or colliding slug unique. */
const HASH_SUFFIX_LENGTH = 8

/** Filesystem/stableId-safe slug for a raw value (which may hold `/`, `:`). Not cut. */
export function slugifyKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Short, stable hash of a raw id. */
function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, HASH_SUFFIX_LENGTH)
}

/**
 * The local part of an Unraid PrefixedID (`<server hash>:<local id>`). Every id of one
 * server shares the prefix, so a key built from the front of the full id collapses
 * every disk and container of the server onto one key.
 */
export function localIdOf(id: string): string {
  const cut = id.lastIndexOf(':')
  return cut < 0 ? id : id.slice(cut + 1)
}

/** One item a per-item key is built for: its raw id, or its name when the id is empty. */
export interface UnraidKeyedItem {
  readonly id: string
  readonly name: string
}

/**
 * Collision-free key slugs for one section (disks, containers, VMs), aligned with
 * `items`. The slug is the local part of the id; a slug longer than
 * {@link MAX_SLUG_LENGTH} is cut and suffixed with a hash of the FULL id, and so is
 * every slug two items share (ids that differ only in case or punctuation), so no two
 * items ever map to one key. An item with neither id nor name gets `''` (skipped).
 */
export function sectionSlugs(items: readonly UnraidKeyedItem[]): readonly string[] {
  const raw = items.map((item) => {
    const source = item.id.length > 0 ? item.id : item.name
    return { source, slug: slugifyKey(item.id.length > 0 ? localIdOf(item.id) : item.name) }
  })
  const counts = new Map<string, number>()
  for (const { slug } of raw) counts.set(slug, (counts.get(slug) ?? 0) + 1)
  return raw.map(({ source, slug }) => {
    if (slug.length === 0) return ''
    const shared = (counts.get(slug) ?? 0) > 1
    if (!shared && slug.length <= MAX_SLUG_LENGTH) return slug
    const head = slug.slice(0, MAX_SLUG_LENGTH - HASH_SUFFIX_LENGTH - 1).replace(/-+$/, '')
    return `${head}-${shortHash(source)}`
  })
}

/** Clamp a raw percentage into 0..100 (defensive — a hung feed can overshoot). */
function pct(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, value))
}

/** Array capacity + parity + CPU + notification-count metric descriptors. */
function arrayMetricDescriptors(snapshot: UnraidSnapshot): UnraidEntityDescriptor[] {
  const { array, cpu, notifications } = snapshot
  // Unknown (absent, or a stopped array's zero total) is null on every reading, never 0 (D393).
  const capacity = knownArrayCapacityBytes(array.capacityKb)
  const usagePercent =
    capacity === null || capacity.used === null ? null : pct((capacity.used / capacity.total) * 100)

  const out: UnraidEntityDescriptor[] = [
    {
      key: 'array_state',
      kind: 'enum',
      capName: 'enum-sensor',
      deviceType: DeviceType.Sensor,
      name: 'Array state',
      role: DeviceRole.EnumSensor,
      enumValue: array.state,
    },
    {
      key: 'array_usage',
      kind: 'numeric',
      capName: 'numeric-sensor',
      deviceType: DeviceType.Sensor,
      name: 'Array usage',
      role: DeviceRole.NumericSensor,
      numeric: { value: usagePercent, quantity: 'percentage' },
    },
    {
      key: 'array_total',
      kind: 'numeric',
      capName: 'numeric-sensor',
      deviceType: DeviceType.Sensor,
      name: 'Array total',
      role: DeviceRole.NumericSensor,
      numeric: { value: capacity?.total ?? null, quantity: 'information' },
    },
    {
      key: 'array_used',
      kind: 'numeric',
      capName: 'numeric-sensor',
      deviceType: DeviceType.Sensor,
      name: 'Array used',
      role: DeviceRole.NumericSensor,
      numeric: { value: capacity?.used ?? null, quantity: 'information' },
    },
    {
      key: 'array_free',
      kind: 'numeric',
      capName: 'numeric-sensor',
      deviceType: DeviceType.Sensor,
      name: 'Array free',
      role: DeviceRole.NumericSensor,
      numeric: { value: capacity?.free ?? null, quantity: 'information' },
    },
    {
      key: 'cpu_usage',
      kind: 'numeric',
      capName: 'numeric-sensor',
      deviceType: DeviceType.Sensor,
      name: 'CPU usage',
      role: DeviceRole.NumericSensor,
      numeric: { value: pct(cpu.percent), quantity: 'percentage' },
    },
    {
      key: 'parity_check_progress',
      kind: 'numeric',
      capName: 'numeric-sensor',
      deviceType: DeviceType.Sensor,
      name: 'Parity check progress',
      role: DeviceRole.NumericSensor,
      numeric: { value: pct(array.parityCheck?.progress ?? 0), quantity: 'percentage' },
    },
    {
      key: 'active_notifications',
      kind: 'numeric',
      capName: 'numeric-sensor',
      deviceType: DeviceType.Sensor,
      name: 'Active notifications',
      role: DeviceRole.NumericSensor,
      numeric: { value: Math.max(0, notifications.activeCount), quantity: 'count' },
    },
  ]

  // CPU temperature / power are emitted only when the host reports them (many
  // servers expose neither) — an honest, present-only surface.
  if (cpu.tempC !== null) {
    out.push({
      key: 'cpu_temperature',
      kind: 'temperature',
      capName: 'temperature-sensor',
      deviceType: DeviceType.Sensor,
      name: 'CPU temperature',
      role: DeviceRole.TemperatureSensor,
      celsius: cpu.tempC,
    })
  }
  if (cpu.powerW !== null) {
    out.push({
      key: 'cpu_power',
      kind: 'numeric',
      capName: 'numeric-sensor',
      deviceType: DeviceType.Sensor,
      name: 'CPU power',
      role: DeviceRole.PowerSensor,
      numeric: { value: Math.max(0, cpu.powerW), quantity: 'power' },
    })
  }
  return out
}

/** Array boolean descriptors (started / config-valid / parity-valid / running / disks). */
function arrayBinaryDescriptors(snapshot: UnraidSnapshot): UnraidEntityDescriptor[] {
  const { array } = snapshot
  const started = array.state === 'STARTED'
  const parityCheckRunning = array.parityCheck?.running ?? false
  // A slot is unhealthy when it reports `healthy === false`. `disks_healthy`
  // is true only when every member slot is healthy.
  const disksHealthy = array.disks.every((disk) => disk.healthy)
  // `config_valid` / `parity_valid` are not first-class in the read model here;
  // derive conservative booleans from the array state via string Sets (kept as
  // `ReadonlySet<string>` so `array.state` is NOT narrowed by control flow — a
  // literal `===`/`!==` on a narrowed union would be flagged as unreachable).
  const configErrorStates: ReadonlySet<string> = new Set([
    'INVALID_EXPANSION',
    'PARITY_NOT_BIGGEST',
    'TOO_MANY_MISSING_DISKS',
    'NEW_DISK_TOO_SMALL',
    'DISABLE_DISK',
    'SWAP_DSBL',
  ])
  const parityErrorStates: ReadonlySet<string> = new Set([
    'INVALID_EXPANSION',
    'PARITY_NOT_BIGGEST',
    'RECON_DISK',
    'DISABLE_DISK',
    'SWAP_DSBL',
  ])
  const configValid = !configErrorStates.has(array.state)
  const parityValid = !parityErrorStates.has(array.state)

  return [
    binaryDescriptor('array_started', 'Array started', started, DeviceRole.BinarySensor),
    binaryDescriptor('config_valid', 'Config valid', configValid, DeviceRole.BinarySensor),
    binaryDescriptor('parity_valid', 'Parity valid', parityValid, DeviceRole.BinarySensor),
    binaryDescriptor(
      'parity_check_running',
      'Parity check running',
      parityCheckRunning,
      DeviceRole.BinarySensor,
    ),
    binaryDescriptor('disks_healthy', 'Disks healthy', disksHealthy, DeviceRole.BinarySensor),
  ]
}

function binaryDescriptor(
  key: string,
  name: string,
  on: boolean,
  role: DeviceRole,
): UnraidEntityDescriptor {
  return {
    key,
    kind: 'binary',
    capName: 'binary',
    deviceType: DeviceType.Sensor,
    name,
    role,
    binary: on,
  }
}

/** The four array lifecycle buttons. */
function arrayButtonDescriptors(): UnraidEntityDescriptor[] {
  return [
    buttonDescriptor('start_array', 'Start array', { type: 'start-array' }),
    buttonDescriptor('stop_array', 'Stop array', { type: 'stop-array' }),
    buttonDescriptor('start_parity_check', 'Start parity check', { type: 'start-parity' }),
    buttonDescriptor('stop_parity_check', 'Stop parity check', { type: 'stop-parity' }),
  ]
}

function buttonDescriptor(
  key: string,
  name: string,
  action: UnraidButtonAction,
): UnraidEntityDescriptor {
  return {
    key,
    kind: 'button',
    capName: 'button',
    deviceType: DeviceType.Button,
    name,
    action,
  }
}

/** Per-disk usage (numeric %) + health (binary problem). Partial by design. */
function diskDescriptors(disks: readonly UnraidArrayDiskInfo[]): UnraidEntityDescriptor[] {
  const out: UnraidEntityDescriptor[] = []
  const slugs = sectionSlugs(disks)
  for (const [index, disk] of disks.entries()) {
    const slug = slugs[index] ?? ''
    if (slug.length === 0) continue
    const size = disk.fsSizeBytes ?? 0
    const used = disk.fsUsedBytes ?? 0
    const usagePercent = size > 0 ? pct((used / size) * 100) : 0
    out.push({
      key: `disk_${slug}_usage`,
      kind: 'numeric',
      capName: 'numeric-sensor',
      deviceType: DeviceType.Sensor,
      name: `${disk.name} usage`,
      role: DeviceRole.NumericSensor,
      numeric: { value: usagePercent, quantity: 'percentage' },
    })
    // `problem` semantics: the binary is ON when the disk is UNhealthy.
    out.push({
      key: `disk_${slug}_health`,
      kind: 'binary',
      capName: 'binary',
      deviceType: DeviceType.Sensor,
      name: `${disk.name} problem`,
      role: DeviceRole.BinarySensor,
      binary: !disk.healthy,
    })
  }
  return out
}

/** The single notifications event-emitter descriptor (`tower_notifications`). */
function notificationEventDescriptor(): UnraidEntityDescriptor {
  return {
    key: 'tower_notifications',
    kind: 'event',
    capName: 'event-emitter',
    deviceType: DeviceType.EventEmitter,
    name: 'Notifications',
  }
}

/**
 * Turn a full {@link UnraidSnapshot} into the flat entity-descriptor list. Order
 * is stable (array metrics → array binaries → array buttons → disks → notifications)
 * so a diff of persisted identities is deterministic. The docker and VM lists are not
 * read here, so a poll whose list failed (`null`) changes no entity.
 */
export function buildEntityDescriptors(
  snapshot: UnraidSnapshot,
): readonly UnraidEntityDescriptor[] {
  return [
    ...arrayMetricDescriptors(snapshot),
    ...arrayBinaryDescriptors(snapshot),
    ...arrayButtonDescriptors(),
    ...diskDescriptors(snapshot.disks),
    notificationEventDescriptor(),
  ]
}

/** The persisted identity list — what the Hub writes onto the Container. */
export function buildEntityIdentities(snapshot: UnraidSnapshot): readonly UnraidEntityIdentity[] {
  return buildEntityDescriptors(snapshot).map(entityIdentity)
}

/** Look up the live descriptor for a key in a freshly-built list (or null). */
export function findDescriptor(
  descriptors: readonly UnraidEntityDescriptor[],
  key: string,
): UnraidEntityDescriptor | null {
  return descriptors.find((descriptor) => descriptor.key === key) ?? null
}
