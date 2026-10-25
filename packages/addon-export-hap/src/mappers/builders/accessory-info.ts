/**
 * `Service.AccessoryInformation` — the manufacturer / model / firmware /
 * serial block every HomeKit accessory carries.
 *
 * One implementation for both accessory shapes (camera and generic): the
 * fields come from the device's own metadata either way, and a second copy
 * would be a second answer to "what serial does this device publish".
 * Metadata is best-effort — a device that cannot answer still publishes.
 */
import { Characteristic, Service, type Accessory } from '@homebridge/hap-nodejs'

import type { DeviceProxy } from '@camstack/types'

interface DeviceMetaLike {
  readonly model?: string | null
  readonly manufacturer?: string | null
  readonly firmware?: string | null
  readonly sn?: string | null
}

export async function populateAccessoryInfo(
  accessory: Accessory,
  proxy: DeviceProxy,
  displayName: string,
  modelFallback: string,
): Promise<void> {
  const info = accessory.getService(Service.AccessoryInformation)
  if (!info) return
  try {
    const device = await proxy.deviceManager?.getDevice({})
    const metadata = readMetadata(device)
    info.setCharacteristic(Characteristic.Name, device?.name ?? displayName)
    info.setCharacteristic(
      Characteristic.Manufacturer,
      stringOr(metadata?.manufacturer, 'CamStack'),
    )
    info.setCharacteristic(Characteristic.Model, stringOr(metadata?.model, modelFallback))
    info.setCharacteristic(Characteristic.FirmwareRevision, stringOr(metadata?.firmware, '0.0.0'))
    info.setCharacteristic(
      Characteristic.SerialNumber,
      stringOr(metadata?.sn, `camstack-${proxy.deviceId}`),
    )
  } catch {
    /* metadata is best-effort; never fatal */
  }
}

/** The four fields this module reads, or `null` — the device record's
 *  `metadata` is an open bag and nothing else here depends on its shape. */
function readMetadata(device: { readonly metadata?: unknown } | null | undefined): DeviceMetaLike {
  const metadata = device?.metadata
  if (metadata === null || typeof metadata !== 'object') return {}
  const entries = new Map(Object.entries(metadata))
  return {
    model: stringOrNull(entries.get('model')),
    manufacturer: stringOrNull(entries.get('manufacturer')),
    firmware: stringOrNull(entries.get('firmware')),
    sn: stringOrNull(entries.get('sn')),
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}
