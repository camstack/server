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
}

export interface ClaimDevicesPorts {
  /** The registry rows of `addonId`. */
  listIntegrations(addonId: string): Promise<readonly ClaimIntegration[]>
  /** Every persisted device of `addonId`, whether or not it is running. */
  listDevices(addonId: string): Promise<readonly ClaimDevice[]>
  /** Patch the one `integrationId` field of a device. */
  setIntegrationId(deviceId: number, integrationId: string): Promise<void>
  /** The device's integration id as stored; null when none. */
  readIntegrationId(deviceId: number): Promise<string | null>
  info(message: string): void
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

export async function claimDevicesToDefaultIntegration(
  ports: ClaimDevicesPorts,
  spec: ClaimDevicesSpec,
): Promise<MigrationProcedureResult> {
  const orphans = (await ports.listDevices(spec.addonId)).filter(unstamped)
  if (orphans.length === 0) return { outcome: 'already-done', summary: { claimed: 0 } }

  const target = defaultIntegrationOf(await ports.listIntegrations(spec.addonId), spec.eligible)
  if (target === null) {
    throw new Error(
      `${orphans.length} device(s) of '${spec.addonId}' carry no integration and the addon has no integration to claim them to`,
    )
  }
  for (const device of orphans) {
    await ports.setIntegrationId(device.id, target.id)
  }
  const wrong: number[] = []
  for (const device of orphans) {
    if ((await ports.readIntegrationId(device.id)) !== target.id) wrong.push(device.id)
  }
  if (wrong.length > 0) {
    throw new Error(
      `device(s) ${wrong.join(', ')} did not read back integration '${target.id}' after the claim`,
    )
  }
  ports.info(
    `${orphans.length} device(s) of '${spec.addonId}' claimed to integration '${target.id}'`,
  )
  return { outcome: 'done', summary: { claimed: orphans.length, integrationId: target.id } }
}
