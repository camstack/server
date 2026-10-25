/**
 * The ONE owner of "which steps, with which models, does this camera attach
 * with on this (node, device)" (D650).
 *
 * Every path that sets or replaces an attach's `steps` goes through
 * {@link resolveAttachPipeline}: the standing dispatch and a rebalance
 * migration (`placement-service.ts`), the on-motion session
 * (`session-dispatch-controller.ts`), and the re-attaches after an executor
 * readiness epoch (`node-lifecycle-handler.ts`) and a package-zone change
 * (`orchestrator-bootstrap.ts`). It runs AFTER the device is elected, because
 * which steps a camera can run depends on it:
 *
 *  1. the node's jump roster (`buildJumpRoster`),
 *  2. the STRUCTURE-ONLY tree for the elected device + roster
 *     (`resolvePipelineForDevice(…, deviceKey, jumpTargetKeys(roster))`) —
 *     never an already-provisioned tree carried over from a previous attach,
 *  3. the elected device's provisioning onto that tree
 *     (`applyDeviceProvisioning`), and every roster entry's provisioning for
 *     the jumped steps (`provisionDeviceSteps`) — both from ONE read of each
 *     settings blob (`readDeviceProvisioning`).
 *
 * Before this module, the standing path resolved on the node DEFAULT format
 * before election (a tflite-default node lost face/plate/CLIP even when the CPU
 * was elected) and the re-attach paths replaced steps with a tree that carried
 * no provisioning at all.
 */
import type {
  CameraPipelineConfig,
  PipelineStepInputOutput,
  RunnerCameraConfig,
  RunnerInferenceDevice,
} from '@camstack/types'
import { applyDeviceProvisioning, provisionDeviceSteps } from './apply-device-provisioning.js'
import { buildJumpRoster, jumpTargetKeys } from './jump-roster.js'
import type { PipelineSettingsStore } from './pipeline-settings-store.js'

/** What an attach runs: the provisioned tree, audio, the elected device and its roster. */
export interface AttachPipeline {
  readonly steps: readonly PipelineStepInputOutput[]
  readonly audio: RunnerCameraConfig['audio']
  readonly deviceKey?: string
  readonly inferenceDevices?: readonly RunnerInferenceDevice[]
}

export interface AttachPipelineInput {
  readonly deviceId: number
  readonly nodeId: string
  /** The elected device; absent ⇒ the runner's default pool. */
  readonly deviceKey: string | undefined
  /** Enabled∧available devices of the node, `deviceKey → weight`. */
  readonly eligible: Readonly<Record<string, number>>
  /** `deviceKey → maxSessions`. */
  readonly caps: Readonly<Record<string, number>>
}

export type AttachPipelineStore = Pick<
  PipelineSettingsStore,
  | 'resolvePipelineForDevice'
  | 'resolvePipelineForDeviceWithRoots'
  | 'resolvePipelineForDeviceIfCatalogCached'
  | 'readDeviceProvisioning'
>

/**
 * A pipeline to attach — or a REFUSAL: the elected device cannot run the
 * CAMERA ROOT (`object-detection`, D650 round 3). An attach without its root
 * detects nothing, and once its assignment is recorded nothing re-places it;
 * the caller must not attach, and must say why. Only that root refuses — the
 * same one the election guard checks. Any other root the device cannot run
 * (segmentation) is skipped and logged by the resolve, as on main (round 4).
 */
export type AttachPipelineOutcome =
  | { readonly kind: 'resolved'; readonly pipeline: AttachPipeline }
  | {
      readonly kind: 'root-refused'
      readonly nodeId: string
      readonly deviceKey: string | undefined
      readonly droppedRoots: readonly string[]
    }

/**
 * The outcome of the NON-BLOCKING entry point: also the node whose catalog is
 * not cached (its executor has not answered yet).
 */
export type AttachPipelineIfCached =
  | AttachPipelineOutcome
  | { readonly kind: 'catalog-unavailable'; readonly nodeId: string }

/**
 * BLOCKING entry point: waits for the node's catalog (`resolvePipelineForDevice`
 * reconciles against the executor until it answers). For a FIRST placement —
 * a camera's first standing dispatch, an on-motion session, a re-attach —
 * where there is nothing better to attach than the real pipeline. See the
 * module header.
 */
export async function resolveAttachPipeline(
  input: AttachPipelineInput,
  store: AttachPipelineStore,
): Promise<AttachPipelineOutcome> {
  const roster = buildJumpRoster({
    deviceKey: input.deviceKey,
    eligible: input.eligible,
    caps: input.caps,
  })
  const resolved = await store.resolvePipelineForDeviceWithRoots(
    input.deviceId,
    input.nodeId,
    input.deviceKey,
    jumpTargetKeys(roster, input.deviceKey),
  )
  if (resolved.droppedRoots.length > 0) return rootRefusal(input, resolved.droppedRoots)
  return {
    kind: 'resolved',
    pipeline: await provisionAttachPipeline(input, roster, resolved.config, store),
  }
}

/**
 * NON-BLOCKING entry point: reads the node's catalog from the cache only, and
 * answers `catalog-unavailable` instead of waiting (D650 round 2). For the
 * RETRY and re-place paths — a pending retry, a remote-health re-place, a
 * rebalance migration — which run cameras serially in one sweep: one node
 * whose executor never answers must leave ITS camera pending, not hold every
 * camera behind it (D3, D49).
 */
export async function resolveAttachPipelineIfCatalogCached(
  input: AttachPipelineInput,
  store: AttachPipelineStore,
): Promise<AttachPipelineIfCached> {
  const roster = buildJumpRoster({
    deviceKey: input.deviceKey,
    eligible: input.eligible,
    caps: input.caps,
  })
  const outcome = await store.resolvePipelineForDeviceIfCatalogCached(
    input.deviceId,
    input.nodeId,
    input.deviceKey,
    jumpTargetKeys(roster, input.deviceKey),
  )
  if (outcome.kind === 'catalog-unavailable') return outcome
  if (outcome.droppedRoots.length > 0) return rootRefusal(input, outcome.droppedRoots)
  return {
    kind: 'resolved',
    pipeline: await provisionAttachPipeline(input, roster, outcome.config, store),
  }
}

function rootRefusal(
  input: AttachPipelineInput,
  droppedRoots: readonly string[],
): AttachPipelineOutcome {
  return { kind: 'root-refused', nodeId: input.nodeId, deviceKey: input.deviceKey, droppedRoots }
}

/**
 * Whose provisioning an attach applies. The elected device when there is one.
 * With NO elected device the runner's default pool serves the camera; when the
 * node has exactly one eligible device the balancer returns
 * `single-eligible-device` and that default pool IS that device (a Mac's
 * `coreml:all`, an N100 with only its iGPU on), so its model pin and the
 * camera's override stored under its key apply (D745 — before, the empty key
 * was read, which no store writes, and the pin was silently never run).
 * Otherwise `''`: the node's folded settings with no hardware fields.
 */
export function provisioningKeyFor(input: AttachPipelineInput): string {
  if (input.deviceKey !== undefined) return input.deviceKey
  const eligibleKeys = Object.keys(input.eligible)
  return eligibleKeys.length === 1 ? (eligibleKeys[0] ?? '') : ''
}

/** Steps 3 of the module header: provision the resolved structure. */
async function provisionAttachPipeline(
  input: AttachPipelineInput,
  roster: readonly RunnerInferenceDevice[] | undefined,
  resolved: CameraPipelineConfig,
  store: AttachPipelineStore,
): Promise<AttachPipeline> {
  const { deviceId, nodeId, deviceKey } = input
  // The base is read even WITHOUT an elected deviceKey (default-pool dispatch):
  // step SETTINGS are node-scoped and fold across accelerators (D210). The
  // camera's layer is settings-only and the same on every device (D927), so a
  // jumped step carries it with it.
  const electedKey = provisioningKeyFor(input)
  const rosterKeys = (roster ?? []).map((d) => d.deviceKey)
  const sources = await store.readDeviceProvisioning(deviceId, nodeId, [
    ...new Set([electedKey, ...rosterKeys]),
  ])
  const elected = sources.get(electedKey)
  const steps = applyDeviceProvisioning(
    resolved.steps,
    elected?.base ?? {},
    elected?.override ?? {},
  )
  const inferenceDevices = roster?.map((entry): RunnerInferenceDevice => {
    const src = sources.get(entry.deviceKey)
    return {
      ...entry,
      steps: provisionDeviceSteps(resolved.steps, src?.base ?? {}, src?.override ?? {}),
    }
  })
  return {
    steps,
    audio: resolved.audio ?? null,
    ...(deviceKey ? { deviceKey } : {}),
    ...(inferenceDevices ? { inferenceDevices } : {}),
  }
}

/**
 * `config` with its pipeline REPLACED by `pipeline`. The four pipeline fields
 * are removed first, so a previous attach's `deviceKey` / roster never survives
 * a spread when the new pipeline has none (a migration to a single-device node,
 * a re-dispatch from a ledger config).
 */
export function withAttachPipeline(
  config: RunnerCameraConfig,
  pipeline: AttachPipeline,
): RunnerCameraConfig {
  const {
    deviceKey: _deviceKey,
    inferenceDevices: _inferenceDevices,
    steps: _steps,
    audio: _audio,
    ...rest
  } = config
  return { ...rest, ...pipeline }
}
