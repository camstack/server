/**
 * The per-(node, device) provisioning base (D927).
 *
 * A step's configuration on a node comes from two stored places, each read for
 * exactly what it owns:
 *
 *   - `agentSettings[node].stepSettings[step]` — NODE-wide content: operator
 *     intent that must hold whichever accelerator the balancer picks (a
 *     species allow-list, an IoU). Never a model or a model-bound threshold.
 *   - `agentSettings[node].inferenceDevices[deviceKey].steps[step]` — THAT
 *     accelerator: its `modelId`, its `jumpDeviceKey` and its own settings
 *     (the model-bound `minConfidence*` floors, which belong to the model that
 *     runs there). Read for the requested device only.
 *
 * Settings merge per key, the device's own winning. No sibling entry is ever
 * read — the fold this replaces took a step's settings from ANY device of the
 * node, a disabled one included, which is how production came to keep its
 * only `animal-classifier.enabledClasses` on the switched-off `cpu` entry.
 */
import type { DeviceStepConfig } from '@camstack/types'

/** The slice of a node's stored settings the base reads. */
export interface NodeStepSource {
  readonly stepSettings?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly inferenceDevices?: Readonly<
    Record<
      string,
      {
        /** Not read: a device's entry configures that device whether or not it is on. */
        readonly enabled: boolean
        readonly steps?: Readonly<Record<string, DeviceStepConfig>>
      }
    >
  >
}

/**
 * The provisioning base for `deviceKey` (`''` = the runner's default pool,
 * which has no device entry and takes the node layer alone). Pure; fresh
 * objects only.
 */
export function nodeDeviceBase(
  node: NodeStepSource | undefined,
  deviceKey: string,
): Record<string, DeviceStepConfig> {
  const own = node?.inferenceDevices?.[deviceKey]?.steps ?? {}
  const nodeLayer = node?.stepSettings ?? {}
  const out: Record<string, DeviceStepConfig> = {}
  for (const stepId of new Set([...Object.keys(nodeLayer), ...Object.keys(own)])) {
    const device = own[stepId]
    const merged = { ...nodeLayer[stepId], ...device?.settings }
    out[stepId] = {
      ...(device?.modelId !== undefined ? { modelId: device.modelId } : {}),
      ...(device?.jumpDeviceKey !== undefined ? { jumpDeviceKey: device.jumpDeviceKey } : {}),
      ...(Object.keys(merged).length > 0 ? { settings: merged } : {}),
    }
  }
  return out
}
