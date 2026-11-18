/**
 * Pure, DEVICE-AWARE resolver — STRUCTURE ONLY (per-(node,device) config).
 *
 * The resolver derives the enabled step TREE (which steps run + how they nest);
 * it attaches NO `modelId` / `settings` — that is a separate provisioning stage
 * ({@link applyDeviceProvisioning}) run at dispatch once the balancer has picked
 * the concrete `(node, deviceKey)`. A step runs for a camera on a device iff it
 * is gated ON ({@link gateStep}: cluster mode, camera toggle, node switch —
 * D1065) AND a device it may run on, and has not switched it off, has a
 * compatible model in the catalog: the ELECTED
 * device for a root, the elected device or any device of the node's jump
 * roster for a detail step (D650). `audio-classifier` is gated by enablement
 * only — it does not run on an inference pool.
 *
 * Inputs:
 *   - `cameraSettings.stepToggles`  — the per-camera layer (sparse; absent
 *     key = the cluster mode's default: on for `on`, off for `opt-in`).
 *   - `switches`                    — the cluster modes, the node switches and
 *     the device switches (D1065, {@link StepSwitchContext}).
 *   - `deviceFormat`                — the chosen inference device's model format
 *     (`onnx` / `coreml` / `openvino` / `tflite` / …); the per-DEVICE skip check
 *     keys off it (was the single `catalog.selectedEngine.format`).
 *   - `jumpFormats`                 — the formats of the node's OTHER enabled
 *     devices the runner may jump a detail step to (the attach's roster).
 *
 * Output: {@link ResolvedPipeline} — the canonical `CameraPipelineConfig` (steps
 * carry no model) plus the gated-on-but-unprovisioned `skipped` steps (for a
 * visible SKIP status).
 *
 * Zero I/O: the caller owns persistence + catalog fetching. This module
 * is safe to unit test without any storage mock.
 */
import type {
  CameraPipelineConfig,
  CameraPipelineSettings,
  PipelineSchema,
  PipelineAddonSchema,
  PipelineSlotSchema,
  PipelineStepInputOutput,
  StepClusterMode,
} from '@camstack/types'
import { stepModelRunsOnFormat } from '@camstack/types'

/**
 * The `package-detection` root step id. Zone-driven activation
 * ({@link applyPackageZoneActivation}) is keyed on it — the step has NO
 * user-facing toggle; a drawn package zone is the sole enable signal.
 */
export const PACKAGE_DETECTION_STEP_ID = 'package-detection'

/**
 * The CAMERA ROOT: the always-on object-detection step every session's tracks
 * originate from. The ONE definition behind two gates that must agree (D650
 * round 4): the device election's root guard (`makeRootCapabilityGuard`)
 * excludes a device whose format cannot run it, and the attach backstop
 * (`ResolvedPipeline.droppedRoots`) refuses an attach that lost it. Any other
 * gated-on root the elected device cannot run (`segmentation`, an opt-in
 * refiner) is a logged skip, never a refusal: the election does not look at
 * it, so refusing on it left a camera pending forever.
 *
 * Mirrors the addon-pipeline step id — a cross-addon import is forbidden.
 */
export const OBJECT_DETECTION_STEP_ID = 'object-detection'

/**
 * Zone-driven activation for the toggle-less `package-detection` root step.
 *
 * The step runs for a device IFF it has ≥1 package zone (an enabled
 * `package`-stage zone rule referencing geometry). There is deliberately NO
 * operator toggle — drawing a package zone IS the enable, removing every
 * package zone IS the disable. This gate reconciles the resolved step tree to
 * that rule:
 *
 *  - `hasPackageZone` true  → the step is ensured present as an ENABLED root
 *    (a pre-existing node keeps its `modelId` / `settings` — e.g. a per-node
 *    model choice); default-on where a zone is present.
 *  - `hasPackageZone` false → any `package-detection` node is stripped so the
 *    runner never dispatches it.
 *
 * `package-detection` is a ROOT (`inputClasses: null`) so it only ever appears
 * at the top level — no recursion into children needed. Every other step is
 * left untouched. Immutable: returns a fresh array only when a change applies.
 */
export function applyPackageZoneActivation(
  steps: CameraPipelineConfig['steps'],
  hasPackageZone: boolean,
): CameraPipelineConfig['steps'] {
  const existing = steps.find((s) => s.addonId === PACKAGE_DETECTION_STEP_ID)

  if (!hasPackageZone) {
    if (!existing) return steps
    return steps.filter((s) => s.addonId !== PACKAGE_DETECTION_STEP_ID)
  }

  if (existing) {
    if (existing.enabled === true) return steps
    return steps.map((s) => (s.addonId === PACKAGE_DETECTION_STEP_ID ? { ...s, enabled: true } : s))
  }

  // Absent + a package zone exists → append a bare enabled root. No `modelId`
  // (the executing node resolves its own format default at runtime, per the
  // data-only model-selection design).
  const node: PipelineStepInputOutput = {
    addonId: PACKAGE_DETECTION_STEP_ID,
    enabled: true,
    children: [],
  }
  return [...steps, node]
}

/**
 * Why a gated-ON step was dropped (D650):
 *  - `no-compatible-model` — NO device the step may run on has a build: not the
 *    elected device, and (for a detail step) no device of the node's jump roster.
 *  - `root-not-runnable-on-elected-device` — a ROOT step whose builds exist only
 *    on other devices of the node. The root is the elected device's job and is
 *    never jumped, so a roster that could run it does not keep it.
 */
export type FormatSkipReason = 'no-compatible-model' | 'root-not-runnable-on-elected-device'
/**
 * Why a step the camera (or the cluster default) wanted was dropped: a format
 * reason above, or a switch (D1065) — the cluster mode is `off`, the node
 * switch is off, or the device switch left it no device to run on.
 */
export type SkipReason =
  | FormatSkipReason
  | 'disabled-on-cluster'
  | 'disabled-on-node'
  | 'disabled-on-device'
export interface SkippedStep {
  readonly addonId: string
  readonly reason: SkipReason
}

/** Resolver output + the gated-on-but-unprovisioned steps (D2 SKIP status). */
export interface ResolvedPipeline {
  readonly config: CameraPipelineConfig
  readonly skipped: readonly SkippedStep[]
  /**
   * The CAMERA ROOT ({@link OBJECT_DETECTION_STEP_ID}) when it is gated on and
   * the elected device cannot run it (D650 round 3) — a subset of `skipped`,
   * and never any other root. Non-empty means the election put the camera on
   * a device that cannot run its own detector; the placement refuses such an
   * attach rather than recording a camera that detects nothing. Kept as a
   * list so the refusal names what it lost.
   */
  readonly droppedRoots: readonly string[]
  /**
   * Whether the switches let `package-detection` run at all (D1065): false
   * when its cluster mode is `off`, or the node or the elected device switched
   * it off. The caller's zone activation adds it only when this is true.
   */
  readonly packageAllowed: boolean
}

/**
 * PROVISIONING presence for `(addon, format)` — the node "provides" the step
 * iff a pool of that format can run it, by the ONE placement rule every
 * placement reads (`stepModelRunsOnFormat`, D657). The resolver is
 * structure-only, so the step names no model here ("Auto"): a NON-legacy
 * model must ship the build. A legacy stub never makes a format provisioned.
 */
export function addonHasCompatibleModel(addon: PipelineAddonSchema, format: string): boolean {
  return stepModelRunsOnFormat(addon.models ?? [], null, format)
}

/**
 * A ROOT runs on the frame plane of the ELECTED device and is never jumped
 * (D650). Roots are the video steps with no `inputClasses`.
 */
function isVideoRoot(addon: PipelineAddonSchema): boolean {
  return (addon.inputClasses ?? []).length === 0
}

// ── Step switches (D1065) ──────────────────────────────────────────────
//
// ONE gate and ONE placement, shared by the attach path
// (`resolvePipelineWithSkips`) and the inspector read
// (`step-switch-matrix.ts`), so the matrix cannot show a cell the attach would
// not produce. Precedence: cluster off > camera toggle (else the cluster
// default) > node off > device off / jump.

/** The cluster mode a step runs under when none is stored: the catalog default. */
export function defaultClusterStepMode(addon: PipelineAddonSchema): StepClusterMode {
  return addon.enabledByDefault === false ? 'opt-in' : 'on'
}

/** The cluster mode in force: the stored one, else the catalog default. */
export function effectiveClusterStepMode(
  addon: PipelineAddonSchema,
  stored: StepClusterMode | undefined,
): StepClusterMode {
  return stored ?? defaultClusterStepMode(addon)
}

/** The switch layers above the device, for one (camera, node, step). */
export interface StepGateLayers {
  /** The stored cluster mode; absent = the catalog default. */
  readonly clusterMode?: StepClusterMode
  /** The camera's `stepToggles[step]`; absent = the cluster mode's default. */
  readonly cameraToggle?: boolean
  /** The node switch (`stepEnabled[step]`); absent = inherit. */
  readonly nodeEnabled?: boolean
}

/**
 * Whether a step is on for a camera on a node, before any device is asked.
 * `disabled-on-camera` is the operator's per-camera intent and is not a skip;
 * the other two are (D1065).
 */
export type StepGate =
  | { readonly kind: 'on' }
  | {
      readonly kind: 'off'
      readonly reason: 'disabled-on-cluster' | 'disabled-on-camera' | 'disabled-on-node'
    }

export function gateStep(addon: PipelineAddonSchema, layers: StepGateLayers): StepGate {
  const mode = effectiveClusterStepMode(addon, layers.clusterMode)
  if (mode === 'off') return { kind: 'off', reason: 'disabled-on-cluster' }
  const cameraOn = layers.cameraToggle ?? mode === 'on'
  if (!cameraOn) return { kind: 'off', reason: 'disabled-on-camera' }
  if (layers.nodeEnabled === false) return { kind: 'off', reason: 'disabled-on-node' }
  return { kind: 'on' }
}

/** One device a step may run on: its format and the steps switched off on it. */
export interface StepDeviceSlot {
  /** Absent for a format-only roster entry (a caller that knows no keys). */
  readonly deviceKey?: string
  readonly format: string
  readonly disabledSteps: ReadonlySet<string>
}

/**
 * Where a gated-on step runs, given the elected device and the node's jump
 * roster (the OTHER enabled∧available devices, D650):
 *  - `run`  — the elected device runs it. `audio-classifier` always runs: it
 *    never runs on an inference pool (the audio-analyzer has its own backend),
 *    so neither an inference format nor a device switch says anything about it.
 *  - `jump` — a DETAIL step the elected device does not run (no build, or
 *    switched off there), taken by an allowed roster device. `toDeviceKey` is
 *    the first such device by key; at runtime the runner's step-tree jump
 *    (`pipeline-runner/device-jump.ts`) picks the least-loaded one.
 *  - `skip` — nothing it may run on: `disabled-on-device` when a switch took
 *    away the devices that had a build, else the format reason.
 * A ROOT is never jumped: it runs on the elected device or is skipped.
 */
export type StepDevicePlacement =
  | { readonly kind: 'run' }
  | { readonly kind: 'jump'; readonly toDeviceKey: string | undefined }
  | { readonly kind: 'skip'; readonly reason: FormatSkipReason | 'disabled-on-device' }

export function placeStepOnDevices(
  addon: PipelineAddonSchema,
  elected: StepDeviceSlot,
  roster: readonly StepDeviceSlot[],
): StepDevicePlacement {
  if (addon.slot === 'audio-classifier') return { kind: 'run' }
  const builds = (slot: StepDeviceSlot): boolean => addonHasCompatibleModel(addon, slot.format)
  const allowed = (slot: StepDeviceSlot): boolean => !slot.disabledSteps.has(addon.id)
  const electedBuild = builds(elected)
  if (electedBuild && allowed(elected)) return { kind: 'run' }
  if (isVideoRoot(addon)) {
    if (!allowed(elected)) return { kind: 'skip', reason: 'disabled-on-device' }
    return roster.some(builds)
      ? { kind: 'skip', reason: 'root-not-runnable-on-elected-device' }
      : { kind: 'skip', reason: 'no-compatible-model' }
  }
  const takers = roster
    .filter((slot) => builds(slot) && allowed(slot))
    .toSorted((a, b) => slotOrderKey(a).localeCompare(slotOrderKey(b)))
  const first = takers[0]
  if (first !== undefined) return { kind: 'jump', toDeviceKey: first.deviceKey }
  const switchedAway = (electedBuild && !allowed(elected)) || roster.some(builds)
  return { kind: 'skip', reason: switchedAway ? 'disabled-on-device' : 'no-compatible-model' }
}

function slotOrderKey(slot: StepDeviceSlot): string {
  return slot.deviceKey ?? slot.format
}

/**
 * The switch context of one resolve (D1065). Every field is optional: an
 * absent map means nothing is switched, which is the behaviour before D1065.
 */
export interface StepSwitchContext {
  /** The stored cluster modes, `stepId → mode`. */
  readonly clusterModes?: Readonly<Record<string, StepClusterMode>>
  /** The node switches of the node the camera runs on, `stepId → enabled`. */
  readonly nodeStepEnabled?: Readonly<Record<string, boolean>>
  /** The steps switched off on the ELECTED device. */
  readonly electedDisabledSteps?: ReadonlySet<string>
  /**
   * The jump roster with each device's switched-off steps. When given it
   * replaces the format-only `jumpFormats` argument.
   */
  readonly jumpTargets?: readonly StepDeviceSlot[]
}

const NO_STEPS: ReadonlySet<string> = new Set<string>()

/** The gate layers of `addonId` read from a switch context (absent entries stay absent). */
function gateLayersOf(addonId: string, switches: StepSwitchContext): StepGateLayers {
  const clusterMode = switches.clusterModes?.[addonId]
  const nodeEnabled = switches.nodeStepEnabled?.[addonId]
  return {
    ...(clusterMode !== undefined ? { clusterMode } : {}),
    ...(nodeEnabled !== undefined ? { nodeEnabled } : {}),
  }
}

// `emptyPipeline` helper was removed together with the `disableInference`
// short-circuit — the detection-pipeline binding is now consulted by the
// caller (resolvePipelineForDevice) which handles the empty-pipeline
// short-circuit inline.

/**
 * Main resolver — produces the STRUCTURE-ONLY `CameraPipelineConfig` for
 * `(camera, node, deviceFormat)`. Pure: zero I/O, zero side effects. Carries
 * no `modelId` / `settings`; the provisioning stage attaches those after the
 * balancer picks the concrete device.
 *
 * Thin wrapper over {@link resolvePipelineWithSkips} for callers that only
 * want the config.
 */
export function resolvePipeline(
  cameraSettings: CameraPipelineSettings | null,
  deviceFormat: string,
  catalog: PipelineSchema,
): CameraPipelineConfig {
  return resolvePipelineWithSkips(cameraSettings, deviceFormat, catalog).config
}

/**
 * Device-aware resolver — the SINGLE per-camera gate + per-DEVICE skip check.
 *
 * Step `S` runs for camera `C` on device `D`  ⇔
 *   gate(C, N, S)       — {@link gateStep}: cluster not off, the camera toggle
 *                         (else the cluster default), the node switch (D1065)
 *   AND provided(D, S)  — {@link placeStepOnDevices}: a device not switched off
 *                         for S has a build of it — the catalog lists a model with a build for D's FORMAT
 *                         (a ROOT), or for D's format or any `jumpFormats`
 *                         entry (a detail step — the runner jumps it, D650);
 *                         `audio-classifier` is never format-gated (it runs
 *                         on the audio-analyzer's own backend)
 *
 * Provisioning
 * (`modelId` / `settings`) is NOT applied here — the returned tree carries bare
 * `{ addonId, enabled: true, children }` nodes; {@link applyDeviceProvisioning}
 * attaches model + settings at dispatch from the per-(node,device) base and the
 * camera's settings-only layer (a camera carries no model, D927).
 *
 * A step gated ON that no device it may run on can serve is DROPPED and
 * recorded in `skipped` so the caller can surface a visible "gated on, no model
 * on this node" status at dispatch time.
 *
 * `package-detection` is excluded from the tree — it is zone-driven
 * ({@link applyPackageZoneActivation}, applied by the caller); the cluster,
 * node and elected-device switches still apply, as `packageAllowed` (D1065).
 *
 * "Inference disabled for this camera" is NOT handled here — the caller
 * (resolvePipelineForDevice) consults the detection-pipeline binding and
 * short-circuits to an empty pipeline before invoking this resolver.
 */
export function resolvePipelineWithSkips(
  cameraSettings: CameraPipelineSettings | null,
  deviceFormat: string,
  catalog: PipelineSchema,
  jumpFormats: readonly string[] = [],
  switches: StepSwitchContext = {},
): ResolvedPipeline {
  const cam = cameraSettings ?? {}

  const toggles = cam.stepToggles ?? {}
  const elected: StepDeviceSlot = {
    format: deviceFormat,
    disabledSteps: switches.electedDisabledSteps ?? NO_STEPS,
  }
  const roster: readonly StepDeviceSlot[] =
    switches.jumpTargets ?? jumpFormats.map((format) => ({ format, disabledSteps: NO_STEPS }))
  let packageAllowed = true

  // 1. Walk the CATALOG (the authoritative step set). For each step: apply the
  //    single per-camera gate, then the AND-provisioned per-DEVICE skip check.
  const enabled: EnabledAddon[] = []
  const skipped: SkippedStep[] = []
  const droppedRoots: string[] = []
  for (const slot of catalog.slots) {
    for (const addon of slot.addons) {
      const addonId = addon.id
      const layers = gateLayersOf(addonId, switches)
      // Zone-driven: a drawn zone, not a camera toggle, turns it on (the
      // caller's applyPackageZoneActivation). The switches still apply — a
      // cluster, node or elected-device off keeps it off whatever the zones say.
      if (addonId === PACKAGE_DETECTION_STEP_ID) {
        const gate = gateStep(addon, { ...layers, cameraToggle: true })
        packageAllowed = gate.kind === 'on' && !elected.disabledSteps.has(addonId)
        continue
      }
      // The enablement gate (D1065): cluster off beats everything, then the
      // camera's stepToggles (absent = the cluster mode's default), then the
      // node switch.
      const cameraToggle = toggles[addonId]
      const gate = gateStep(addon, {
        ...layers,
        ...(cameraToggle !== undefined ? { cameraToggle } : {}),
      })
      if (gate.kind === 'off') {
        // A camera turning a step off is its intent, not a skip.
        if (gate.reason !== 'disabled-on-camera') skipped.push({ addonId, reason: gate.reason })
        continue
      }
      // AND-provisioned: gated on but no device the step may run on (a build,
      // and not switched off there) → SKIP with a recorded status.
      const placement = placeStepOnDevices(addon, elected, roster)
      if (placement.kind === 'skip') {
        const reason = placement.reason
        skipped.push({ addonId, reason })
        // Only the camera root is a REFUSAL — the same root the election
        // guard checks, so the two cannot disagree. Every other dropped root
        // is the logged skip above (round 4). A root the operator switched off
        // on this device is intent (D1065), not a device the election got
        // wrong: it is skipped, never refused.
        if (addonId === OBJECT_DETECTION_STEP_ID && reason !== 'disabled-on-device') {
          droppedRoots.push(addonId)
        }
        continue
      }
      enabled.push({ addonId })
    }
  }

  // 2. Split audio-classifier (goes into CameraPipelineConfig.audio)
  //    from video addons (go into the steps tree).
  const audioAddons: EnabledAddon[] = []
  const videoAddons: EnabledAddon[] = []
  for (const entry of enabled) {
    const meta = findInCatalog(catalog, entry.addonId)
    if (!meta) continue // unknown addon, skip silently
    if (meta.slot === 'audio-classifier') audioAddons.push(entry)
    else videoAddons.push(entry)
  }

  // 3. Build the video tree via catalog compat (inputClasses ↔ parent outputClasses)
  const steps = buildTreeFromAddons(videoAddons, catalog)

  // 4. Audio — structure only. Enabled flag from presence; NO modelId/settings
  //    (the provisioning stage / node format-default resolves the audio model).
  const audio = audioAddons.length > 0 ? { enabled: true } : null

  return { config: { steps, audio }, skipped, droppedRoots, packageAllowed }
}

interface EnabledAddon {
  readonly addonId: string
}

function findInCatalog(catalog: PipelineSchema, addonId: string): PipelineAddonSchema | null {
  for (const slot of catalog.slots) {
    for (const addon of slot.addons) {
      if (addon.id === addonId) return addon
    }
  }
  return null
}

/**
 * Compose a step tree from a flat list of enabled video addons using
 * catalog compatibility: an addon whose `inputClasses` overlaps a
 * candidate parent's `outputClasses` attaches as the parent's child.
 * Addons with `inputClasses` null/empty become roots.
 *
 * Multiple addons in the same slot with compatible inputClasses run in
 * parallel — they attach to the same parent as siblings. Example: two
 * classifiers (bird-classifier + animal-classifier) both accept 'animal'
 * → both attach to object-detection as siblings, both receive every
 * animal crop.
 *
 * Unparented leaves (inputClasses set, but no matching parent in the
 * enabled set) are DROPPED. The runner would have nothing to feed them
 * anyway — better silent drop than dispatching a dead step.
 */
export function buildTreeFromAddons(
  enabled: readonly EnabledAddon[],
  catalog: PipelineSchema,
): CameraPipelineConfig['steps'] {
  interface TreeNode {
    readonly addonId: string
    readonly enabled: true
    readonly children: TreeNode[]
  }
  const bySlot = new Map<string, PipelineSlotSchema>()
  for (const slot of catalog.slots) bySlot.set(slot.id, slot)

  const nodes = new Map<string, TreeNode>()
  const metaById = new Map<string, PipelineAddonSchema>()
  for (const { addonId } of enabled) {
    const meta = findInCatalog(catalog, addonId)
    if (!meta) continue
    metaById.set(addonId, meta)
    // STRUCTURE ONLY — no modelId/settings (provisioning is a later stage).
    nodes.set(addonId, { addonId, enabled: true, children: [] })
  }

  const roots: TreeNode[] = []
  for (const [addonId, node] of nodes) {
    const meta = metaById.get(addonId)!
    const inputs = meta.inputClasses
    if (!inputs || inputs.length === 0) {
      roots.push(node)
      continue
    }
    // Find first enabled parent whose outputClasses overlap with this addon's inputs.
    let parent: TreeNode | null = null
    for (const [candidateId, candidateNode] of nodes) {
      if (candidateId === addonId) continue
      const candidateMeta = metaById.get(candidateId)!
      if (candidateMeta.outputClasses.some((c) => inputs.includes(c))) {
        parent = candidateNode
        break
      }
    }
    if (parent) parent.children.push(node)
    // else: orphan — drop silently
  }
  return roots
}
