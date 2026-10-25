/**
 * Generic accessory orchestrator — every camstack device that is NOT a camera.
 *
 * Same three steps as the camera orchestrator, and deliberately nothing more:
 *  1. resolve the typed `DeviceProxy`,
 *  2. select rows from the capability→service table with the device's BOUND
 *     capabilities (never its type — see `builders/generic/cap-service-table.ts`),
 *  3. let each row add its service to one `Accessory`.
 *
 * It publishes standalone, like the camera path: one accessory, one mDNS
 * advertisement, one pairing, the shared setup code. This addon is not a
 * bridge — that decision predates this file and is not re-litigated here.
 *
 * ## It REFUSES rather than publishing an empty tile
 *
 * A device whose capabilities select no row throws. The alternative is an
 * accessory carrying nothing but `AccessoryInformation`: it pairs, it appears
 * in the Home app, it does nothing, and the operator has no way to tell that
 * from a broken integration. The Export tab is gated on the same question
 * (`hap-export.addon.ts`), so reaching this throw means the device changed
 * shape between the tab rendering and the toggle landing.
 */
import { Accessory } from '@homebridge/hap-nodejs'

import { type AddonContext, DeviceType, type DeviceProxy } from '@camstack/types'

import { populateAccessoryInfo } from './builders/accessory-info.js'
import { accessoryCategoryFor, rowsForCaps } from './builders/generic/cap-service-table.js'
import { accessoryUuidFor } from './kind.js'
import type { BuilderContext, BuilderHandle, CameraMapperOptions, Mapper } from './types.js'

export interface GenericAccessoryInput {
  readonly ctx: AddonContext
  readonly deviceId: string
  readonly displayName: string
  readonly options: CameraMapperOptions
}

export async function buildGenericAccessory(input: GenericAccessoryInput): Promise<Mapper> {
  const { ctx, deviceId, displayName, options } = input
  const numericId = Number.parseInt(deviceId, 10)
  if (!Number.isFinite(numericId)) {
    throw new Error(`export-hap: cannot map device '${deviceId}' — id is not numeric`)
  }
  const log = ctx.logger.withTags({ deviceId: numericId })

  const proxy = await ctx.fetchDevice(numericId)
  const capNames = new Set(proxy.binding?.entries.map((e) => e.capName) ?? [])
  const rows = rowsForCaps(capNames)
  if (rows.length === 0) {
    throw new Error(
      `export-hap: device ${numericId} carries no capability HomeKit can export ` +
        `(bound: ${[...capNames].toSorted().join(', ') || 'none'})`,
    )
  }

  const deviceType = await resolveDeviceType(proxy)
  const accessory = new Accessory(displayName, accessoryUuidFor('generic', numericId))
  accessory.category = accessoryCategoryFor(deviceType)

  await populateAccessoryInfo(accessory, proxy, displayName, 'Accessory')

  const bctx: BuilderContext = {
    ctx,
    accessory,
    proxy,
    numericDeviceId: numericId,
    displayName,
    options,
  }

  const handles: BuilderHandle[] = []
  for (const row of rows) {
    const name = rows.length === 1 ? displayName : row.label
    handles.push(await row.build({ bctx, name, deviceType }))
  }

  log.info('export-hap: built generic accessory', {
    meta: {
      deviceType,
      services: rows.map((row) => row.caps[0]).join(','),
    },
  })

  return {
    accessory,
    accessories: [accessory],
    async dispose(): Promise<void> {
      for (const handle of handles) {
        try {
          await handle.dispose()
        } catch (err) {
          log.debug('export-hap: generic builder dispose failed (continuing)', {
            meta: { error: errMsg(err) },
          })
        }
      }
    },
  }
}

/**
 * The device's own type, or `Generic`.
 *
 * Used ONLY where one capability has two HomeKit shapes — a siren's
 * `brightness` is alarm volume, not luminosity — and for the accessory's icon.
 * `Generic` is the safe reading: it is the shape `child-switch.ts` already
 * treats as "a lamp if it dims, a switch otherwise".
 */
async function resolveDeviceType(proxy: DeviceProxy): Promise<DeviceType> {
  try {
    const device = await proxy.deviceManager?.getDevice({})
    const raw = typeof device?.type === 'string' ? device.type.toLowerCase() : ''
    return Object.values(DeviceType).find((value) => value === raw) ?? DeviceType.Generic
  } catch {
    return DeviceType.Generic
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
