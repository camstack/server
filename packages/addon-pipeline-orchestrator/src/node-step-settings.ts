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
import type { DeviceStepConfig } from '@dominevo/types'

/** The slice of a node's stored settings the base reads. */
export interface NodeStepSource {
  readonly stepSettings?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  /** The node switches (D1065), `stepId → enabled`. */
  readonly stepEnabled?: Readonly<Record<string, boolean>>
  readonly inferenceDevices?: Readonly<
    Record<
      string,
      {
        /**
         * Read only by {@link poolDisabledSteps}; a device's entry configures
         * that device whether or not it is on.
         */
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

/**
 * The steps switched OFF on `deviceKey` of this node (D1065):
 * `inferenceDevices[deviceKey].steps[step].enabled === false`. Only that
 * device's own entry is read; `''` (the default pool) has none.
 */
export function deviceDisabledSteps(
  node: NodeStepSource | undefined,
  deviceKey: string,
): ReadonlySet<string> {
  const steps = node?.inferenceDevices?.[deviceKey]?.steps ?? {}
  return new Set(
    Object.entries(steps)
      .filter(([, cfg]) => cfg.enabled === false)
      .map(([stepId]) => stepId),
  )
}

/**
 * The steps a DEFAULT-POOL attach (no elected device) must not run (D1065):
 * those switched off on EVERY device the pool may be. The pool is the node's
 * eligible devices (one eligible device IS the pool, D745); with none
 * eligible it is any device the node has enabled. A step one of them still
 * allows is kept — the pool may be that device. No candidate ⇒ nothing.
 */
export function poolDisabledSteps(
  node: NodeStepSource | undefined,
  eligibleKeys: readonly string[],
): ReadonlySet<string> {
  const candidates =
    eligibleKeys.length > 0
      ? eligibleKeys
      : Object.entries(node?.inferenceDevices ?? {})
          .filter(([, device]) => device.enabled)
          .map(([key]) => key)
  const [first, ...rest] = candidates.map((key) => deviceDisabledSteps(node, key))
  if (first === undefined) return new Set<string>()
  return new Set([...first].filter((stepId) => rest.every((steps) => steps.has(stepId))))
}
