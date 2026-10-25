/**
 * Pure, DEVICE-AWARE resolver — STRUCTURE ONLY (per-(node,device) config).
 *
 * The resolver derives the enabled step TREE (which steps run + how they nest);
 * it attaches NO `modelId` / `settings` — that is a separate provisioning stage
 * ({@link applyDeviceProvisioning}) run at dispatch once the balancer has picked
 * the concrete `(node, deviceKey)`. A step runs for a camera on a device iff it
 * is gated ON (`stepToggles[S]` ?? `addon.enabledByDefault ?? true`) AND a
 * device it may run on has a compatible model in the catalog: the ELECTED
 * device for a root, the elected device or any device of the node's jump
 * roster for a detail step (D650). `audio-classifier` is gated by enablement
 * only — it does not run on an inference pool.
 *
 * Inputs:
 *   - `cameraSettings.stepToggles`  — the SOLE per-camera enablement gate
 *     (sparse; absent key = the catalog default `enabledByDefault ?? true`).
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
export type SkipReason = 'no-compatible-model' | 'root-not-runnable-on-elected-device'
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

/**
 * The per-DEVICE provisioning gate (D650). `null` = keep the step.
 *
 *  - `audio-classifier` is NOT gated here at all. It never runs on an
 *    inference pool — the audio-analyzer runs its own backend (YAMNet in an
 *    embedded-Python subprocess, or Apple SoundAnalysis) — so an inference
 *    format says nothing about whether it can run. Only enablement applies.
 *  - A video ROOT needs a build for the ELECTED device's format — the runner
 *    never jumps it, so a sibling accelerator that could run it is irrelevant.
 *  - A detail step is kept when the elected format OR any format of the
 *    node's jump roster (`jumpFormats` — the SAME enabled∧available devices
 *    the runner jumps within) has a build: the runner's step-tree jump
 *    (`pipeline-runner/device-jump.ts`) then places it.
 */
function unprovisionedReason(
  addon: PipelineAddonSchema,
  electedFormat: string,
  jumpFormats: readonly string[],
): SkipReason | null {
  if (addon.slot === 'audio-classifier') return null
  if (addonHasCompatibleModel(addon, electedFormat)) return null
  if (isVideoRoot(addon)) {
    return jumpFormats.some((f) => addonHasCompatibleModel(addon, f))
      ? 'root-not-runnable-on-elected-device'
      : 'no-compatible-model'
  }
  return jumpFormats.some((f) => addonHasCompatibleModel(addon, f)) ? null : 'no-compatible-model'
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
 *   gate(C, S)          — `stepToggles[S]` ?? `addon.enabledByDefault ?? true`
 *   AND provided(D, S)  — the catalog lists a model with a build for D's FORMAT
 *                         (a ROOT), or for D's format or any `jumpFormats`
 *                         entry (a detail step — the runner jumps it, D650);
 *                         `audio-classifier` is never format-gated (it runs
 *                         on the audio-analyzer's own backend)
 *
 * Enablement is the per-camera `stepToggles` authority ONLY. Provisioning
 * (`modelId` / `settings`) is NOT applied here — the returned tree carries bare
 * `{ addonId, enabled: true, children }` nodes; {@link applyDeviceProvisioning}
 * attaches model + settings at dispatch from the per-(node,device) base and the
 * camera's settings-only layer (a camera carries no model, D927).
 *
 * A step gated ON that no device it may run on can serve is DROPPED and
 * recorded in `skipped` so the caller can surface a visible "gated on, no model
 * on this node" status at dispatch time.
 *
 * `package-detection` is excluded here — it is zone-driven
 * ({@link applyPackageZoneActivation}, applied by the caller).
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
): ResolvedPipeline {
  const cam = cameraSettings ?? {}

  const toggles = cam.stepToggles ?? {}
  const format = deviceFormat

  // 1. Walk the CATALOG (the authoritative step set). For each step: apply the
  //    single per-camera gate, then the AND-provisioned per-DEVICE skip check.
  const enabled: EnabledAddon[] = []
  const skipped: SkippedStep[] = []
  const droppedRoots: string[] = []
  for (const slot of catalog.slots) {
    for (const addon of slot.addons) {
      const addonId = addon.id
      // Zone-driven — never gated here; the caller's applyPackageZoneActivation
      // is the sole authority for package-detection.
      if (addonId === PACKAGE_DETECTION_STEP_ID) continue
      // The ONLY enablement gate: per-camera stepToggles, defaulting to the
      // catalog's enabledByDefault (absent = on).
      const gated = toggles[addonId] ?? addon.enabledByDefault ?? true
      if (!gated) continue
      // AND-provisioned: gated on but no device the step may run on has a
      // build → SKIP with a recorded status. Never synthesize + auto-resolve.
      const reason = unprovisionedReason(addon, format, jumpFormats)
      if (reason !== null) {
        skipped.push({ addonId, reason })
        // Only the camera root is a REFUSAL — the same root the election
        // guard checks, so the two cannot disagree. Every other dropped root
        // is the logged skip above (round 4).
        if (addonId === OBJECT_DETECTION_STEP_ID) droppedRoots.push(addonId)
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

  return { config: { steps, audio }, skipped, droppedRoots }
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
