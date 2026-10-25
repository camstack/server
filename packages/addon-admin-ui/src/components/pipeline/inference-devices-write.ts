/**
 * The ONE payload builder for `pipelineOrchestrator.setAgentInferenceDevices`
 * — shared by both write surfaces (the placement board's
 * `NodeInferenceDevices` and the per-node `NodeDeviceStepsMatrix`).
 *
 * The mutation REPLACES a node's stored `inferenceDevices` map wholesale, and
 * the backend resolves an ABSENT key to its policy default (`autoDefault` in
 * `mergeInferenceDevices`), which is ON for every accelerator except CPU and
 * the Coral. Both surfaces therefore MUST write every device they show with
 * its honest `enabled` bit:
 *
 *   - a device the operator switched OFF is written as `enabled: false` —
 *     that is the only durable way to say "off" for an opt-OUT accelerator;
 *   - absence from the payload is reserved for hardware the surface was never
 *     shown (never-configured — e.g. plugged in later), which keeps its
 *     policy default so new hardware never arrives silently disabled.
 *
 * History (2026-08-01): both surfaces used to PRUNE disabled rows, so
 * "switch it off" stored NOTHING and nothing meant on — a mistakenly-enabled
 * Coral could not be switched off (its toggle read OFF while it kept taking
 * every third session of camera 101, hours at 2.4fps), and any disabled
 * opt-OUT accelerator came straight back on. Do not reintroduce pruning; the
 * unit guard (`__tests__/inference-devices-write.spec.ts`) pins this.
 */
import type { DeviceStepConfig } from '@camstack/types'

/** One device row as a write surface sees it (its draft or the live view). */
export interface InferenceDeviceWriteSource {
  readonly key: string
  readonly enabled: boolean
  readonly weight: number
  /** Hard ceiling on concurrent sessions; null = unlimited. */
  readonly maxSessions: number | null
  /** Per-(node,device) BASE step map (`stepId → {modelId?, settings?}`). */
  readonly steps: Readonly<Record<string, DeviceStepConfig>>
}

/** One stored entry of the wholesale `setAgentInferenceDevices` payload. */
export interface InferenceDeviceWriteEntry {
  readonly enabled: boolean
  readonly weight: number
  readonly maxSessions?: number
  readonly steps?: Readonly<Record<string, DeviceStepConfig>>
}

/**
 * Build the complete replacement map from every device row a surface shows.
 * Every source key appears in the output — disabled rows included. The backend
 * requires a strictly positive weight, so a 0%-dragged row is floored at 1;
 * `maxSessions` is sent only when a positive cap is set (unlimited → omitted);
 * `steps` only when non-empty.
 */
/** The fields of a device row the provisioning base reads. */
export interface StepSettingsDevice {
  readonly key: string
  readonly steps?: Readonly<Record<string, DeviceStepConfig>>
}

/**
 * The settings one step runs with on `deviceKey`, as the RUNTIME builds them
 * (`nodeDeviceBase`, D927): the node-wide bag (`agentSettings[node].
 * stepSettings[step]`) under that device's OWN entry — a sibling device's
 * entry is never read. `deviceKey` undefined = the node layer alone. Returns
 * `undefined` when neither layer carries anything.
 */
export function effectiveStepSettingsForDevice(
  sources: readonly StepSettingsDevice[],
  deviceKey: string | undefined,
  addonId: string,
  nodeStepSettings: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  const own =
    deviceKey === undefined
      ? undefined
      : sources.find((s) => s.key === deviceKey)?.steps?.[addonId]?.settings
  const merged = { ...nodeStepSettings?.[addonId], ...own }
  return Object.keys(merged).length > 0 ? merged : undefined
}

export function buildInferenceDevicesWrite(
  sources: readonly InferenceDeviceWriteSource[],
): Record<string, InferenceDeviceWriteEntry> {
  const out: Record<string, InferenceDeviceWriteEntry> = {}
  for (const s of sources) {
    const hasSteps = Object.keys(s.steps).length > 0
    out[s.key] = {
      enabled: s.enabled,
      weight: Math.max(1, s.weight),
      ...(s.maxSessions !== null && s.maxSessions > 0 ? { maxSessions: s.maxSessions } : {}),
      ...(hasSteps ? { steps: s.steps } : {}),
    }
  }
  return out
}
