/**
 * Claim an addon's persisted devices that carry no `integrationId` to the addon's DEFAULT
 * integration (planning#416, operator decision 1): the one a device addon had before any
 * integration was named. The stamp is the device manager's own `setIntegrationId`, a patch of the
 * one `integrationId` column: the device keeps its `deviceId`, its `stableId`, its config and
 * every other field, so history and automations follow the id.
 *
 * Idempotent: a device that already names an integration is never touched, so a rerun is a
 * no-op. Every stamp is read back; a device that does not carry the id afterwards throws and
 * names it. With no eligible integration there is nothing to claim to: it throws (the work is
 * retried on the next boot) rather than reporting `already-done`.
 *
 * The default is the lowest-numbered eligible integration of the addon: the registry ids are
 * allocated in order, so it is the first one the operator ever had. An addon whose registry also
 * holds integrations that are not its default (a hub it migrated) says which are eligible.
 */
import type { MigrationProcedureResult } from './migration.js'

export interface ClaimIntegration {
  readonly id: string
  readonly name: string
  readonly info: Readonly<Record<string, unknown>>
}

export interface ClaimDevice {
  readonly id: number
  readonly integrationId?: string | null | undefined
  /** The owning device; null or absent for a root. */
  readonly parentDeviceId?: number | null | undefined
  /** With `name` and `stableId`: what tells an allocation reservation apart (D376). */
  readonly type?: string | undefined
  readonly name?: string | undefined
  readonly stableId?: string | undefined
}

export interface ClaimDevicesPorts {
  /** The registry rows of `addonId`. */
  listIntegrations(addonId: string): Promise<readonly ClaimIntegration[]>
  /** Every persisted device of `addonId`, whether or not it is running. */
  listDevices(addonId: string): Promise<readonly ClaimDevice[]>
  /** Whether the device has any stored configuration (a reservation has none). */
  hasConfig(deviceId: number): Promise<boolean>
  /** Patch the one `integrationId` field of a device. */
  setIntegrationId(deviceId: number, integrationId: string): Promise<void>
  /** The device's integration id as stored; null when none. */
  readIntegrationId(deviceId: number): Promise<string | null>
  info(message: string): void | Promise<void>
  /** A device the claim could not resolve: the line carries `tags: { deviceId }` (D391). */
  warnDevice(message: string, deviceId: number): void | Promise<void>
}

export interface ClaimDevicesSpec {
  readonly addonId: string
  /** Which integrations can be the default; absent: every integration of the addon. */
  readonly eligible?: (integration: ClaimIntegration) => boolean
}

function ordinalOf(id: string): number {
  const digits = id.replace(/\D+/g, '')
  return digits.length > 0 ? Number(digits) : Number.POSITIVE_INFINITY
}

/** The lowest-numbered eligible integration, or null. */
export function defaultIntegrationOf(
  integrations: readonly ClaimIntegration[],
  eligible: ClaimDevicesSpec['eligible'],
): ClaimIntegration | null {
  const pool = eligible === undefined ? integrations : integrations.filter(eligible)
  const sorted = [...pool].sort(
    (a, b) => ordinalOf(a.id) - ordinalOf(b.id) || (a.id < b.id ? -1 : 1),
  )
  return sorted[0] ?? null
}

function unstamped(device: ClaimDevice): boolean {
  return (
    device.integrationId === undefined ||
    device.integrationId === null ||
    device.integrationId === ''
  )
}

/**
 * An allocation reservation is not a device (D376): `allocateDeviceId` writes a row of type
 * `generic`, named by its stable id, that is not registered and holds no configuration. The hub
 * listing does not carry the `registered` bit, so the shape picks the candidates and the missing
 * configuration decides.
 */
async function isReservation(ports: ClaimDevicesPorts, device: ClaimDevice): Promise<boolean> {
  if (device.type !== 'generic' || device.name === undefined || device.name !== device.stableId) {
    return false
  }
  return !(await ports.hasConfig(device.id))
}

export async function claimDevicesToDefaultIntegration(
  ports: ClaimDevicesPorts,
  spec: ClaimDevicesSpec,
): Promise<MigrationProcedureResult> {
  const all = await ports.listDevices(spec.addonId)
  const byId = new Map(all.map((d) => [d.id, d]))
  const reservations = new Set<number>()
  for (const device of all) {
    if (unstamped(device) && (await isReservation(ports, device))) reservations.add(device.id)
  }
  const orphans = all.filter((d) => unstamped(d) && !reservations.has(d.id))
  const summaryBase = { reservations: reservations.size }
  if (orphans.length === 0) {
    return { outcome: 'already-done', summary: { claimed: 0, unresolved: 0, ...summaryBase } }
  }

  const integrations = await ports.listIntegrations(spec.addonId)
  const fallback = defaultIntegrationOf(integrations, spec.eligible)
  const plan = new Map<number, string>()
  const unresolved = new Set<number>()
  const failed = new Set<number>()

  // The integration a device is stamped with, planned parents first; null when it cannot be.
  const resolve = (device: ClaimDevice, seen: ReadonlySet<number>): string | null => {
    if (!unstamped(device)) return device.integrationId ?? null
    const planned = plan.get(device.id)
    if (planned !== undefined) return planned
    if (failed.has(device.id)) return null
    let target: string | null = null
    const parentId = device.parentDeviceId ?? null
    if (parentId === null) {
      target = fallback?.id ?? null
    } else {
      const parent = byId.get(parentId)
      if (parent !== undefined && !reservations.has(parentId) && !seen.has(parentId)) {
        target = resolve(parent, new Set([...seen, device.id]))
      }
    }
    if (target === null) failed.add(device.id)
    else plan.set(device.id, target)
    return target
  }

  const rootsNeedDefault = orphans.some((d) => (d.parentDeviceId ?? null) === null)
  if (rootsNeedDefault && fallback === null) {
    throw new Error(
      `${orphans.length} device(s) of '${spec.addonId}' carry no integration and the addon has no integration to claim them to`,
    )
  }
  for (const device of orphans) {
    if (resolve(device, new Set([device.id])) === null) unresolved.add(device.id)
  }
  for (const id of unresolved) {
    await ports.warnDevice(
      `device ${id} of '${spec.addonId}' carries no integration and its owner chain does not resolve to one: left unstamped`,
      id,
    )
  }

  // Map insertion order is parents first: a child is planned after the parent it reads from.
  for (const [deviceId, integrationId] of plan) {
    await ports.setIntegrationId(deviceId, integrationId)
  }
  const wrong: number[] = []
  for (const [deviceId, integrationId] of plan) {
    if ((await ports.readIntegrationId(deviceId)) !== integrationId) wrong.push(deviceId)
  }
  if (wrong.length > 0) {
    throw new Error(
      `device(s) ${wrong.join(', ')} did not read back their integration after the claim`,
    )
  }
  const claimed = plan.size
  await ports.info(
    `${claimed} device(s) of '${spec.addonId}' claimed to their owner's integration or the default; ${unresolved.size} unresolved, ${reservations.size} reservation(s) skipped`,
  )
  return {
    outcome: claimed > 0 ? 'done' : 'already-done',
    summary: { claimed, unresolved: unresolved.size, ...summaryBase },
  }
}
