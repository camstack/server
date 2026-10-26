import { z } from 'zod'
import { DeviceRole, DeviceType, type ReadingQuantity } from '@camstack/types'
import type {
  UnraidArrayDiskInfo,
  UnraidContainerInfo,
  UnraidSnapshot,
} from './unraid-client-contract.js'

/**
 * Pure snapshot → entity-descriptor mapping. NO I/O — unit-testable in
 * isolation. One {@link UnraidSnapshot} produces a flat list of
 * {@link UnraidEntityDescriptor}s (identity + routing + live value). The Hub
 * persists the IDENTITY subset (via {@link entityIdentity}) on the instance
 * Container's `entities[]`; the entity children re-run this same function on
 * every snapshot and match their descriptor by `key`, so the persisted list and
 * the live values always line up on the same key space.
 *
 * Coverage (this scaffold): array metrics + array binaries + array buttons +
 * docker containers (switch + cpu% + mem% + restart) + notifications event.
 * Per-disk usage/health is emitted from the array member slots (partial — see
 * `plan-unraid.md`). The VM layer is intentionally omitted.
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
  /** The CamStack capability the child registers for this kind. */
  capName: z.string().min(1),
  /** The DeviceType the child is created as. */
  deviceType: z.enum(DeviceType),
  /** Operator-facing name. */
  name: z.string().min(1),
  /** Semantic role (icon hint), when one clarifies the entity. */
  role: z.enum(DeviceRole).optional(),
  /** Docker container id — present on `switch` entities. */
  containerId: z.string().optional(),
  /** Button dispatch action — present on `button` entities. */
  action: UnraidButtonActionSchema.optional(),
})
export type UnraidEntityIdentity = z.infer<typeof UnraidEntityIdentitySchema>

/** A live numeric reading carried on a `numeric` descriptor. */
export interface UnraidNumericValue {
  readonly value: number
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

/** Filesystem/stableId-safe slug for a raw docker/disk id (which may hold `/`, `:`). */
export function slugifyKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

/** Clamp a raw percentage into 0..100 (defensive — a hung feed can overshoot). */
function pct(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

/** A byte count. Negative or non-finite input is an empty reading, not a guess. */
function bytes(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0
  return value
}

/** Array capacity + parity + CPU + notification-count metric descriptors. */
function arrayMetricDescriptors(snapshot: UnraidSnapshot): UnraidEntityDescriptor[] {
  const { array, cpu, notifications } = snapshot
  const totalKb = array.capacityKb.total
  const usedKb = array.capacityKb.used
  const usagePercent = totalKb > 0 ? pct((usedKb / totalKb) * 100) : 0

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
      numeric: { value: bytes(totalKb * 1024), quantity: 'information' },
    },
    {
      key: 'array_used',
      kind: 'numeric',
      capName: 'numeric-sensor',
      deviceType: DeviceType.Sensor,
      name: 'Array used',
      role: DeviceRole.NumericSensor,
      numeric: { value: bytes(usedKb * 1024), quantity: 'information' },
    },
    {
      key: 'array_free',
      kind: 'numeric',
      capName: 'numeric-sensor',
      deviceType: DeviceType.Sensor,
      name: 'Array free',
      role: DeviceRole.NumericSensor,
      numeric: { value: bytes(array.capacityKb.free * 1024), quantity: 'information' },
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
  for (const disk of disks) {
    const slug = slugifyKey(disk.id.length > 0 ? disk.id : disk.name)
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

/** Per-container switch + cpu% + mem% sensors + restart button. */
function dockerDescriptors(containers: readonly UnraidContainerInfo[]): UnraidEntityDescriptor[] {
  const out: UnraidEntityDescriptor[] = []
  for (const container of containers) {
    const slug = slugifyKey(container.id.length > 0 ? container.id : container.name)
    if (slug.length === 0) continue
    out.push({
      key: `container_${slug}`,
      kind: 'switch',
      capName: 'switch',
      deviceType: DeviceType.Switch,
      name: container.name,
      containerId: container.id,
      switchOn: container.running,
    })
    out.push({
      key: `container_${slug}_cpu`,
      kind: 'numeric',
      capName: 'numeric-sensor',
      deviceType: DeviceType.Sensor,
      name: `${container.name} CPU`,
      role: DeviceRole.NumericSensor,
      numeric: { value: pct(container.cpuPercent), quantity: 'percentage' },
    })
    out.push({
      key: `container_${slug}_memory`,
      kind: 'numeric',
      capName: 'numeric-sensor',
      deviceType: DeviceType.Sensor,
      name: `${container.name} memory`,
      role: DeviceRole.NumericSensor,
      numeric: { value: pct(container.memPercent), quantity: 'percentage' },
    })
    out.push(
      buttonDescriptor(`restart_container_${slug}`, `Restart ${container.name}`, {
        type: 'restart-container',
        containerId: container.id,
      }),
    )
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
 * is stable (array metrics → array binaries → array buttons → disks → dockers →
 * notifications) so a diff of persisted identities is deterministic.
 */
export function buildEntityDescriptors(
  snapshot: UnraidSnapshot,
): readonly UnraidEntityDescriptor[] {
  return [
    ...arrayMetricDescriptors(snapshot),
    ...arrayBinaryDescriptors(snapshot),
    ...arrayButtonDescriptors(),
    ...diskDescriptors(snapshot.disks),
    ...dockerDescriptors(snapshot.dockers),
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
