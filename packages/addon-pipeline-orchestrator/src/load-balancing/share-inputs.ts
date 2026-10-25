/**
 * The two reads of the agent-settings blob the effective shares need (D750),
 * pure so they are tested on their own.
 */
import type { ShareWeights } from '@camstack/types'
import type { AgentSettingsMapBlob } from '../orchestrator-store-schemas.js'

/** The operator's sliders: node `detectWeight` and device `weight` (positive only). */
export function storedShareWeights(blob: AgentSettingsMapBlob): ShareWeights {
  const nodes: Record<string, number> = {}
  const devices: Record<string, Record<string, number>> = {}
  for (const [nodeId, settings] of Object.entries(blob)) {
    if (typeof settings.detectWeight === 'number' && settings.detectWeight > 0) {
      nodes[nodeId] = settings.detectWeight
    }
    const perDevice: Record<string, number> = {}
    for (const [key, entry] of Object.entries(settings.inferenceDevices ?? {})) {
      if (typeof entry.weight === 'number' && entry.weight > 0) perDevice[key] = entry.weight
    }
    if (Object.keys(perDevice).length > 0) devices[nodeId] = perDevice
  }
  return { nodes, devices }
}

/** One device of a node as the dispatcher sees it live (probe + exclusion verdict). */
export interface LiveDeviceRow {
  readonly key: string
  readonly available: boolean
  /** Why the dispatcher drops it; `null` = it is a candidate. */
  readonly exclusion: string | null
}

/** The devices a probe reported, as a comparable string (key + availability). */
export function probedDeviceSignature(
  probed: readonly { readonly key: string; readonly available: boolean }[],
): string {
  return probed
    .map((d) => `${d.key}:${d.available ? 'up' : 'down'}`)
    .toSorted()
    .join(',')
}

export type LiveDevicesByNode = Readonly<Record<string, readonly LiveDeviceRow[]>>

/**
 * A string that changes whenever an input of the automatic shares does: the
 * nodes present, each node's detect capability, which devices are switched on
 * and which detector model each runs. Sliders and caps are left out — they do
 * not change capacity.
 */
export function shareTopologySignature(
  nodeIds: readonly string[],
  blob: AgentSettingsMapBlob,
  live: LiveDevicesByNode = {},
): string {
  const parts = [...nodeIds].toSorted().map((nodeId) => {
    const settings = blob[nodeId]
    // The LIVE set: a device plugged in with nothing stored for it (devices
    // default to on) or one pulled out changes no stored entry, so only the
    // probe sees it. `exclusion === null` is what the dispatcher calls eligible.
    const liveRows = (live[nodeId] ?? [])
      .map((d) => `${d.key}:${d.available ? 'up' : 'down'}:${d.exclusion ?? 'ok'}`)
      .toSorted()
    const devices = Object.entries(settings?.inferenceDevices ?? {})
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => {
        const model = entry.steps?.['object-detection']?.modelId ?? ''
        return `${key}=${entry.enabled ? 'on' : 'off'}:${model}`
      })
    return `${nodeId}|detect=${String(settings?.detect ?? 'default')}|${devices.join(',')}|live=${liveRows.join(',')}`
  })
  return parts.join(';')
}
