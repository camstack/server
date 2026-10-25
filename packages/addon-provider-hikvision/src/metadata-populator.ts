/**
 * Hardware-metadata populator for `HikvisionCamera`.
 *
 * Mirrors `addon-provider-reolink/src/metadata-populator.ts`:
 *   1. Pulls every host-level identification probe ISAPI exposes
 *      (`/ISAPI/System/deviceInfo` + `/ISAPI/System/Network/interfaces/1`).
 *   2. Patches the device-meta `metadata` blob via the kernel's
 *      `device-manager.setMetadata` cap (consumed by the device-detail
 *      Hardware sub-tab — read-only for operators).
 *   3. Refreshes the driver's persisted `deviceCache` blob so the
 *      durable identifiers (`mac`, `serialNumber`) survive a restart
 *      even when the camera is offline and `generateStableId` needs
 *      to re-key on next add.
 *
 * Both writes are idempotent — `setMetadata` short-circuits no-diff
 * patches and `DeviceConfig.setAll(partial)` shallow-merges over the
 * current cache. Failure paths are best-effort: a transient ISAPI
 * error leaves whatever the previous probe wrote in place.
 */

import type { DeviceContext } from '@camstack/types'
import type { HikvisionIsapiClient } from './hikvision-isapi-client.js'

export interface HikvisionMetadataPopulatorTarget {
  readonly id: number
  readonly ctx: DeviceContext
  /** Persist patch helper — same `this.config.setAll(partial)` API the
   *  driver already uses for `deviceCache` updates. */
  readonly setDeviceCachePatch: (cachePatch: Record<string, unknown>) => Promise<void>
}

export async function populateHikvisionMetadata(
  isapi: HikvisionIsapiClient,
  target: HikvisionMetadataPopulatorTarget,
): Promise<void> {
  let info: Awaited<ReturnType<HikvisionIsapiClient['getDeviceInfo']>>
  try {
    info = await isapi.getDeviceInfo()
  } catch (err) {
    target.ctx.logger.info('populateHikvisionMetadata: getDeviceInfo failed — skipping populate', {
      tags: { deviceId: target.id },
      meta: { error: err instanceof Error ? err.message : String(err) },
    })
    return
  }

  let net: Awaited<ReturnType<HikvisionIsapiClient['getNetworkInterfaceInfo']>> | null = null
  try {
    net = await isapi.getNetworkInterfaceInfo()
  } catch (err) {
    target.ctx.logger.debug(
      'populateHikvisionMetadata: getNetworkInterfaceInfo failed (non-fatal)',
      {
        tags: { deviceId: target.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      },
    )
  }

  // ── 1. device-meta `metadata` blob ───────────────────────────────
  const patch: Record<string, unknown> = {
    manufacturer: 'Hikvision',
    ...(info.model ? { model: info.model } : {}),
    ...(info.firmwareVersion ? { firmware: info.firmwareVersion } : {}),
    ...(info.firmwareVersionInfo ? { firmwareDetail: info.firmwareVersionInfo } : {}),
    ...(info.firmwareReleasedDate ? { firmwareReleasedAt: info.firmwareReleasedDate } : {}),
    ...(info.hardwareVersion ? { hardware: info.hardwareVersion } : {}),
    ...(info.serialNumber ? { serialNumber: info.serialNumber } : {}),
    ...(info.deviceType ? { isapiDeviceType: info.deviceType } : {}),
    ...(info.deviceName ? { reportedName: info.deviceName } : {}),
    ...(net?.mac ? { mac: net.mac } : {}),
    ...(net?.ip ? { ip: net.ip } : {}),
    ...(net?.subnetMask ? { subnetMask: net.subnetMask } : {}),
    ...(net?.defaultGateway ? { defaultGateway: net.defaultGateway } : {}),
    ...(net?.addressingType ? { addressingType: net.addressingType } : {}),
    ...(net?.speed ? { linkSpeed: net.speed } : {}),
    ...(net?.mtu ? { mtu: net.mtu } : {}),
  }
  try {
    await (
      target.ctx.api as
        | {
            deviceManager?: {
              setMetadata?: {
                mutate?: (input: {
                  deviceId: number
                  patch: Record<string, unknown>
                }) => Promise<void>
              }
            }
          }
        | undefined
    )?.deviceManager?.setMetadata?.mutate?.({ deviceId: target.id, patch })
    target.ctx.logger.info('populateHikvisionMetadata: metadata patched', {
      tags: { deviceId: target.id },
      meta: { keys: Object.keys(patch) },
    })
  } catch (err) {
    target.ctx.logger.warn('populateHikvisionMetadata: setMetadata failed', {
      tags: { deviceId: target.id },
      meta: { error: err instanceof Error ? err.message : String(err) },
    })
  }

  // ── 2. deviceCache config blob (durable identifiers for stableId)
  const cachePatch: Record<string, unknown> = {}
  if (info.serialNumber) cachePatch['serialNumber'] = info.serialNumber
  if (info.firmwareVersion) cachePatch['firmwareVersion'] = info.firmwareVersion
  if (info.firmwareVersionInfo) cachePatch['firmwareVersionInfo'] = info.firmwareVersionInfo
  if (info.hardwareVersion) cachePatch['hardwareVersion'] = info.hardwareVersion
  if (info.deviceType) cachePatch['isapiDeviceType'] = info.deviceType
  if (net?.mac) cachePatch['mac'] = net.mac
  if (Object.keys(cachePatch).length > 0) {
    try {
      await target.setDeviceCachePatch(cachePatch)
    } catch (err) {
      target.ctx.logger.debug('populateHikvisionMetadata: deviceCache patch failed (non-fatal)', {
        tags: { deviceId: target.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }
}
