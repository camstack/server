/**
 * The renderer's resolver over the state mirror the automation engine already
 * keeps (`ConditionMirror`): current slices, no read per render. The hub
 * adapter lists the devices (alias, caps) from the device rows and hands the
 * mirror the sources `templateMirrorSources` names.
 */
import type { ConditionMirror, DeviceTemplateView, MirrorSource } from '@camstack/types'
import type { DeviceTemplateResolver } from './template-renderer.js'

/** One device a template may name. */
export interface TemplateDeviceEntry {
  readonly deviceId: number
  readonly addonId: string
  readonly stableId: string
  readonly alias: string
  readonly caps: readonly string[]
}

/** The slices the mirror must hold so these devices' templates can render. */
export function templateMirrorSources(
  devices: readonly TemplateDeviceEntry[],
): readonly MirrorSource[] {
  return devices.flatMap((device) =>
    device.caps.map((cap): MirrorSource => ({ kind: 'device', deviceId: device.deviceId, cap })),
  )
}

export function mirrorTemplateResolver(
  mirror: Pick<ConditionMirror, 'sliceOf'>,
  devices: readonly TemplateDeviceEntry[],
  unitOf?: DeviceTemplateView['unitOf'],
): DeviceTemplateResolver {
  const byAlias = new Map<string, TemplateDeviceEntry>()
  for (const device of devices) if (!byAlias.has(device.alias)) byAlias.set(device.alias, device)
  return {
    viewOf(alias) {
      const device = byAlias.get(alias)
      if (device === undefined) return undefined
      const slices: Record<string, unknown> = {}
      for (const cap of device.caps) {
        const slice = mirror.sliceOf(device.deviceId, cap)
        if (slice !== undefined) slices[cap] = slice
      }
      return {
        deviceId: device.deviceId,
        addonId: device.addonId,
        stableId: device.stableId,
        slices,
        ...(unitOf !== undefined ? { unitOf } : {}),
      }
    },
  }
}
