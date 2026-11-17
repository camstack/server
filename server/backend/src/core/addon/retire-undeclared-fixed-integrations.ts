/**
 * A FIXED integration row exists because its addon declares it: the addon seeds it through the
 * hub's seed door (`createInstance({ seed })`), and nothing an operator can call deletes it. When
 * the addon stops declaring `integration-instances` in its manifest (camera-grid, planning#580:
 * its grids became blocks the composer owns), nothing would ever remove the row it seeded, and the
 * Integrations page keeps an empty "Camera Grids" entry forever.
 *
 * The hub owns the seed door, so the hub retires what that door let in: at boot, a fixed row whose
 * addon is INSTALLED and no longer declares `integration-instances` is removed — only when no live
 * device hangs off it. Tombstoned devices are gone from the device list and do not count; a device
 * the addon has not withdrawn yet keeps the row until a later boot, and a line says so. A row whose
 * addon is not installed is kept (it reconnects on reinstall), and a still-declared row (Terminal)
 * is never touched. An unreadable device list retires nothing: unknown is not zero.
 */
import type { Integration } from '@camstack/types'
import { errMsg } from '@camstack/types'

export const INTEGRATION_INSTANCES_CAP_NAME = 'integration-instances'

/** The live device fields the retire reads. */
export interface RetireDeviceRow {
  readonly id: number
  readonly addonId: string
  readonly integrationId?: string
}

export interface RetireLogger {
  info(message: string, context?: RetireLogContext): void
  warn(message: string, context?: RetireLogContext): void
}

export interface RetireLogContext {
  readonly tags?: Readonly<Record<string, string>>
  readonly meta?: Readonly<Record<string, unknown>>
}

export interface RetireFixedIntegrationsPorts {
  readonly logger: RetireLogger
  readonly listIntegrations: () => Promise<readonly Integration[]>
  /** The installed addon's manifest capability names; undefined when it is not installed here. */
  readonly declaredCapabilities: (addonId: string) => readonly string[] | undefined
  /** Live devices; null when the list cannot be read. */
  readonly listDevices: () => Promise<readonly RetireDeviceRow[] | null>
  /** Clear `fixed` and delete the row (the registry refuses to delete a fixed row as is). */
  readonly retire: (integration: Integration) => Promise<void>
}

export interface RetireFixedIntegrationsResult {
  readonly retired: readonly string[]
  readonly kept: readonly string[]
}

function isFixed(integration: Integration): boolean {
  return integration.info?.['fixed'] === true
}

function isUndeclared(ports: RetireFixedIntegrationsPorts, integration: Integration): boolean {
  const declared = ports.declaredCapabilities(integration.addonId)
  return declared !== undefined && !declared.includes(INTEGRATION_INSTANCES_CAP_NAME)
}

function devicesOf(integration: Integration, devices: readonly RetireDeviceRow[]): number {
  return devices.filter(
    (d) =>
      d.integrationId === integration.id ||
      (d.integrationId === undefined && d.addonId === integration.addonId),
  ).length
}

export async function retireUndeclaredFixedIntegrations(
  ports: RetireFixedIntegrationsPorts,
): Promise<RetireFixedIntegrationsResult> {
  const { logger } = ports
  const candidates = (await ports.listIntegrations()).filter(
    (i) => isFixed(i) && isUndeclared(ports, i),
  )
  if (candidates.length === 0) return { retired: [], kept: [] }

  const devices = await ports.listDevices()
  if (devices === null) {
    logger.warn('kept fixed integrations their addon no longer declares: device list unreadable', {
      meta: { integrationIds: candidates.map((c) => c.id) },
    })
    return { retired: [], kept: candidates.map((c) => c.id) }
  }

  const retired: string[] = []
  const kept: string[] = []
  for (const integration of candidates) {
    const tags = { integrationId: integration.id, addonId: integration.addonId }
    const count = devicesOf(integration, devices)
    if (count > 0) {
      logger.info(
        'kept a fixed integration its addon no longer declares: devices still hang off it',
        { tags, meta: { devices: count, name: integration.name } },
      )
      kept.push(integration.id)
      continue
    }
    try {
      await ports.retire(integration)
      logger.info('retired a fixed integration its addon no longer declares', {
        tags,
        meta: { name: integration.name },
      })
      retired.push(integration.id)
    } catch (err: unknown) {
      logger.warn('could not retire a fixed integration its addon no longer declares', {
        tags,
        meta: { error: errMsg(err) },
      })
      kept.push(integration.id)
    }
  }
  return { retired, kept }
}
