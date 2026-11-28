/**
 * The step switch matrix (D1065) — what the inspector shows per step, node
 * and device, computed with the SAME gate and placement the attach path runs
 * (`gateStep` / `placeStepOnDevices` in `pipeline-resolver.ts`). A client
 * renders the cells; it never derives one (the inspector used to, from the
 * catalog default alone, and showed `enabled` for opt-in steps no camera ran).
 *
 * A cell answers "a camera elected onto this device of this node": the camera
 * follows the cluster default, or — for an `opt-in` step — is one of the
 * cameras that turned it on (`opt-in-unused` when there are none). The jump
 * roster of a device is the node's other dispatch-eligible devices
 * (`exclusion === null`, the set the election and `buildJumpRoster` use), and
 * exists only when the node has two or more of them.
 *
 * Pure: the caller reads the stores, the catalogs and the device views.
 */
import type {
  NodeInferenceDevice,
  PipelineAddonSchema,
  PipelineSchema,
  StepClusterMode,
  StepSwitchCell,
  StepSwitchMatrix,
} from '@dominevo/types'
import { isRootSuppliableStepId, resolveRootSupply } from '@dominevo/types'
import { deviceDisabledSteps, nodeDeviceBase, type NodeStepSource } from './node-step-settings.js'
import {
  effectiveClusterStepMode,
  gateStep,
  OBJECT_DETECTION_STEP_ID,
  PACKAGE_DETECTION_STEP_ID,
  placeStepOnDevices,
  type StepDeviceSlot,
} from './pipeline-resolver.js'

/** One node as the matrix reads it. `null` catalog or devices = that read did not answer. */
export interface StepSwitchMatrixNode {
  readonly nodeId: string
  readonly catalog: PipelineSchema | null
  readonly devices: readonly NodeInferenceDevice[] | null
  readonly settings: NodeStepSource | undefined
}

export interface StepSwitchMatrixInput {
  readonly clusterModes: Readonly<Record<string, StepClusterMode>>
  /** Every camera's `stepToggles` (absent map = a camera with none). */
  readonly cameraToggles: readonly Readonly<Record<string, boolean>>[]
  readonly nodes: readonly StepSwitchMatrixNode[]
}

/** The inputs of ONE cell. */
export interface StepSwitchCellInput {
  readonly addon: PipelineAddonSchema
  readonly clusterMode: StepClusterMode | undefined
  readonly camerasEnabling: number
  readonly nodeEnabled: boolean | undefined
  readonly elected: StepDeviceSlot
  readonly roster: readonly StepDeviceSlot[]
  /** The root model on the elected device, when it supplies this step (D730). */
  readonly suppliedByRootModelId?: string
}

/** ONE cell — the gate, then the placement, in the attach path's order. */
export function stepSwitchCell(input: StepSwitchCellInput): StepSwitchCell {
  const { addon, elected } = input
  const layers = {
    ...(input.clusterMode !== undefined ? { clusterMode: input.clusterMode } : {}),
    ...(input.nodeEnabled !== undefined ? { nodeEnabled: input.nodeEnabled } : {}),
  }
  const mode = effectiveClusterStepMode(addon, input.clusterMode)
  if (mode === 'off') return { kind: 'off-cluster' }
  if (addon.id === PACKAGE_DETECTION_STEP_ID) {
    // Zone-driven: the switches apply, the camera toggle does not.
    const gate = gateStep(addon, { ...layers, cameraToggle: true })
    if (gate.kind === 'off')
      return gate.reason === 'disabled-on-node' ? { kind: 'off-node' } : { kind: 'off-cluster' }
    return elected.disabledSteps.has(addon.id) ? { kind: 'off-device' } : { kind: 'zone-driven' }
  }
  if (mode === 'opt-in' && input.camerasEnabling === 0) return { kind: 'opt-in-unused' }
  // A camera that runs the step: the default one, or one that opted in.
  const gate = gateStep(addon, { ...layers, cameraToggle: true })
  if (gate.kind === 'off') {
    return gate.reason === 'disabled-on-node' ? { kind: 'off-node' } : { kind: 'off-cluster' }
  }
  const placement = placeStepOnDevices(addon, elected, input.roster)
  if (placement.kind === 'run') {
    return input.suppliedByRootModelId !== undefined
      ? { kind: 'supplied-by-root', rootModelId: input.suppliedByRootModelId }
      : { kind: 'on' }
  }
  if (placement.kind === 'jump') {
    // Every matrix roster slot carries its key; a keyless jump cannot occur here.
    return placement.toDeviceKey !== undefined
      ? { kind: 'jump', toDeviceKey: placement.toDeviceKey }
      : { kind: 'on' }
  }
  if (placement.reason === 'disabled-on-device') return { kind: 'off-device' }
  return { kind: 'skip', reason: placement.reason }
}

/** The catalog's steps across every answering node, first-seen order, by id. */
function catalogSteps(nodes: readonly StepSwitchMatrixNode[]): readonly PipelineAddonSchema[] {
  const seen = new Map<string, PipelineAddonSchema>()
  for (const node of nodes) {
    for (const slot of node.catalog?.slots ?? []) {
      for (const addon of slot.addons) if (!seen.has(addon.id)) seen.set(addon.id, addon)
    }
  }
  return [...seen.values()]
}

function findAddon(catalog: PipelineSchema, id: string): PipelineAddonSchema | undefined {
  for (const slot of catalog.slots) {
    const found = slot.addons.find((a) => a.id === id)
    if (found) return found
  }
  return undefined
}

/**
 * The root model a device runs: its pin, else the model the executor elects
 * for the device when the root lists it, else the format default.
 */
function rootModelOn(root: PipelineAddonSchema, device: NodeInferenceDevice): string {
  const pin = device.steps?.[OBJECT_DETECTION_STEP_ID]?.modelId
  if (pin !== undefined) return pin
  if (root.models.some((m) => m.id === device.defaultModelId)) return device.defaultModelId
  return root.defaultModelIdByFormat?.[device.format] ?? root.defaultModelId
}

/** The root model id when it supplies `stepId` on `device`, else undefined. */
function suppliedByRoot(
  catalog: PipelineSchema,
  stepId: string,
  device: NodeInferenceDevice,
  settings: NodeStepSource | undefined,
): string | undefined {
  if (!isRootSuppliableStepId(stepId)) return undefined
  const root = findAddon(catalog, OBJECT_DETECTION_STEP_ID)
  if (root === undefined) return undefined
  const rootModelId = rootModelOn(root, device)
  const supplies = root.models.find((m) => m.id === rootModelId)?.suppliesSteps
  const stepSettings = nodeDeviceBase(settings, device.key)[stepId]?.settings
  return resolveRootSupply(stepId, stepSettings, supplies).effective ? rootModelId : undefined
}

function slotOf(device: NodeInferenceDevice, settings: NodeStepSource | undefined): StepDeviceSlot {
  return {
    deviceKey: device.key,
    format: device.format,
    disabledSteps: deviceDisabledSteps(settings, device.key),
  }
}

function countToggles(
  toggles: readonly Readonly<Record<string, boolean>>[],
  stepId: string,
  value: boolean,
): number {
  return toggles.filter((t) => t[stepId] === value).length
}

export function buildStepSwitchMatrix(input: StepSwitchMatrixInput): StepSwitchMatrix {
  const steps = catalogSteps(input.nodes).map((addon) => {
    const clusterMode = input.clusterModes[addon.id]
    const camerasEnabling = countToggles(input.cameraToggles, addon.id, true)
    const nodes = input.nodes.map((node) => {
      const nodeEnabled = node.settings?.stepEnabled?.[addon.id]
      const catalog = node.catalog
      const devices = node.devices
      const nodeAddon = catalog ? findAddon(catalog, addon.id) : undefined
      if (catalog === null || devices === null || nodeAddon === undefined) {
        return {
          nodeId: node.nodeId,
          reachable: false,
          stepEnabled: nodeEnabled ?? null,
          devices: [],
        }
      }
      const eligible = devices.filter((d) => d.exclusion === null)
      return {
        nodeId: node.nodeId,
        reachable: true,
        stepEnabled: nodeEnabled ?? null,
        devices: devices.map((device) => {
          const roster =
            eligible.length >= 2
              ? eligible.filter((d) => d.key !== device.key).map((d) => slotOf(d, node.settings))
              : []
          const supplied = suppliedByRoot(catalog, addon.id, device, node.settings)
          return {
            deviceKey: device.key,
            format: device.format,
            stepEnabled: device.steps?.[addon.id]?.enabled ?? null,
            eligible: device.exclusion === null,
            cell: stepSwitchCell({
              addon: nodeAddon,
              clusterMode,
              camerasEnabling,
              nodeEnabled,
              elected: slotOf(device, node.settings),
              roster,
              ...(supplied !== undefined ? { suppliedByRootModelId: supplied } : {}),
            }),
          }
        }),
      }
    })
    return {
      stepId: addon.id,
      name: addon.name,
      slot: addon.slot,
      clusterMode: clusterMode ?? null,
      effectiveMode: effectiveClusterStepMode(addon, clusterMode),
      camerasEnabling,
      camerasDisabling: countToggles(input.cameraToggles, addon.id, false),
      nodes,
    }
  })
  return { steps }
}
