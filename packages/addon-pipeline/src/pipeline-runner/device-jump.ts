/**
 * Step-tree device jump (same-node, phase 1) — the PURE resolution core.
 *
 * Given the camera's elected ("effective") inference device and the node's
 * enabled-device roster, decide which device ONE enrichment step should run on:
 *
 *   1. A manual `jumpDeviceKey` override wins when it names a candidate that can
 *      run the step (bypasses the auto choice; operator intent).
 *   2. Otherwise, if the effective device's format can run the step's model →
 *      NO jump (the step inherits the effective device — the common case).
 *   3. Otherwise AUTO-jump: among the node's OTHER enabled devices whose format
 *      can run the step (and that are under their `maxSessions` cap), pick the
 *      weighted-least-loaded one — mirroring the balancer's per-device core.
 *   4. If nothing on the node can run it → `no-candidate` (the caller emits the
 *      loud once-per-(camera,step) warn that replaces today's silent degrade).
 *
 * Framework-free + side-effect-free so the whole decision table is unit-testable
 * without a live runner/catalog. The `canRun(format)` predicate is injected by
 * the runner (which owns the model catalog); this module never imports it.
 */
import {
  DEVICE_BACKEND_TO_FORMAT,
  type ModelFormat,
  type PipelineStepInputOutput,
  type RunnerInferenceDevice,
  type RunnerJumpStepProvisioning,
  type StepDefinition,
  stepModelRunsOnFormat,
} from '@camstack/types'

/** One enabled inference device on the node, as the resolver sees it. */
export interface JumpCandidateDevice {
  readonly deviceKey: string
  /** Relative balancer weight (>0). */
  readonly weight: number
  /** Concurrent-session cap; `null` = unlimited. A device at its cap is skipped. */
  readonly maxSessions: number | null
  /** Live attached-session count on this device's pool (weighted-least-loaded input). */
  readonly attachedCameras: number
}

export interface ResolveStepDeviceInput {
  /** The device the step would run on absent any jump (the elected/root device). */
  readonly effectiveDeviceKey: string
  /** ALL enabled inference devices on the node (INCLUDING the effective device). */
  readonly devices: readonly JumpCandidateDevice[]
  /** Operator manual override (`steps[step].jumpDeviceKey`) — wins when it can run. */
  readonly manualJumpDeviceKey?: string
  /**
   * Catalog-derived predicate: can this FORMAT run the step's model? `deviceKey`
   * names the candidate being judged, so the step can be judged with THAT
   * device's provisioning (D657) — a predicate may ignore it.
   */
  readonly canRun: (format: ModelFormat, deviceKey: string) => boolean
}

export type ResolveStepDeviceResult =
  /** The effective device runs the step — no jump. */
  | { readonly kind: 'no-jump'; readonly deviceKey: string }
  /** The step jumps to another same-node device (manual override or auto choice). */
  | { readonly kind: 'jumped'; readonly deviceKey: string; readonly reason: 'manual' | 'auto' }
  /** No enabled device on the node can run the step — keep the effective device + WARN. */
  | { readonly kind: 'no-candidate'; readonly deviceKey: string }

/** The `ModelFormat` of a `<backend>:<device>` key, or `undefined` for an unknown backend. */
function formatOf(deviceKey: string): ModelFormat | undefined {
  const colon = deviceKey.indexOf(':')
  const backend = colon >= 0 ? deviceKey.slice(0, colon) : deviceKey
  return DEVICE_BACKEND_TO_FORMAT[backend]
}

/** True when the step's model has a build for `deviceKey`'s format. */
function canRunOn(
  deviceKey: string,
  canRun: (format: ModelFormat, deviceKey: string) => boolean,
): boolean {
  const format = formatOf(deviceKey)
  return format !== undefined && canRun(format, deviceKey)
}

/** Effective weighted load of a device (session count ÷ weight); lower = preferred. */
function weightedLoad(d: JumpCandidateDevice): number {
  return d.attachedCameras / (d.weight > 0 ? d.weight : 1)
}

/**
 * Weighted-least-loaded pick with a deterministic `deviceKey` tie-break —
 * mirrors the node/device balancer's decision core (least `load/weight`, ties
 * broken stably). `devices` is assumed non-empty.
 */
function pickWeightedLeastLoaded(devices: readonly JumpCandidateDevice[]): JumpCandidateDevice {
  return devices.reduce((best, d) => {
    const dScore = weightedLoad(d)
    const bScore = weightedLoad(best)
    if (dScore < bScore) return d
    if (dScore > bScore) return best
    return d.deviceKey < best.deviceKey ? d : best
  })
}

/** Minimal structural view of a dispatched enrichment subtree (what
 *  {@link buildSubtreeCanRun} walks) — `PipelineStepInputOutput` satisfies it. */
export interface JumpSubtreeStep {
  readonly addonId: string
  readonly enabled?: boolean
  /** The model the step names (an operator pin, or a resolved id); absent = the format default. */
  readonly modelId?: string | null
  readonly children?: readonly JumpSubtreeStep[]
}

/**
 * Build the `canRun` predicate for ONE enrichment dispatch. The step and its
 * enabled descendants ride the SAME `runPipeline` call — one pool, one format
 * (detail-subtree contract: "its inherited children ride the same call → same
 * device") — so a format can run the dispatch only when EVERY catalog-known
 * step in the subtree ships a build for it. Gating only the subtree TOP let a
 * `face-detection` with a tflite build stay on the Coral while its
 * `face-embedding` child (no tflite build anywhere) doomed the call.
 * Unknown/custom addonIds (`getStepDef` → null) have no catalog to gate on
 * and never block. `getStepDef` is injected — this module stays catalog-free.
 * Each step is judged by `stepModelRunsOnFormat` (`@camstack/types`), the one
 * rule every placement reads: a legacy stub build counts only when named (D657).
 */
export function buildSubtreeCanRun(
  step: JumpSubtreeStep,
  getStepDef: (addonId: string) => StepDefinition | null,
): (format: ModelFormat) => boolean {
  const judged: { readonly def: StepDefinition; readonly modelId: string | null | undefined }[] = []
  const walk = (s: JumpSubtreeStep): void => {
    if (s.enabled === false) return
    const def = getStepDef(s.addonId)
    if (def !== null) judged.push({ def, modelId: s.modelId })
    for (const child of s.children ?? []) walk(child)
  }
  walk(step)
  return (format) =>
    judged.every(({ def, modelId }) => stepModelRunsOnFormat(def.models, modelId, format))
}

/**
 * Resolve the device one enrichment step runs on. See the module header for the
 * decision table. Pure — never throws, no I/O.
 */
export function resolveStepDevice(input: ResolveStepDeviceInput): ResolveStepDeviceResult {
  const { effectiveDeviceKey, manualJumpDeviceKey, canRun } = input

  // 1. Manual override wins when the named target is an enabled candidate that
  //    can run the step. A self-pointing or invalid override is ignored (the
  //    orchestrator rejects invalid targets at save; be defensive at runtime).
  if (manualJumpDeviceKey !== undefined && manualJumpDeviceKey !== effectiveDeviceKey) {
    const target = input.devices.find((d) => d.deviceKey === manualJumpDeviceKey)
    if (target && canRunOn(target.deviceKey, canRun)) {
      return { kind: 'jumped', deviceKey: target.deviceKey, reason: 'manual' }
    }
  }

  // 2. The effective device can run it → inherit it (no jump).
  if (canRunOn(effectiveDeviceKey, canRun)) {
    return { kind: 'no-jump', deviceKey: effectiveDeviceKey }
  }

  // 3. Auto-jump among OTHER enabled devices that can run it, under their cap.
  const runnable = input.devices.filter(
    (d) =>
      d.deviceKey !== effectiveDeviceKey &&
      (d.maxSessions === null || d.attachedCameras < d.maxSessions) &&
      canRunOn(d.deviceKey, canRun),
  )
  if (runnable.length === 0) {
    return { kind: 'no-candidate', deviceKey: effectiveDeviceKey }
  }
  return { kind: 'jumped', deviceKey: pickWeightedLeastLoaded(runnable).deviceKey, reason: 'auto' }
}

/**
 * Re-provision a jumped subtree for its TARGET device (D650): every step's
 * `modelId` / `settings` are REPLACED by the target's entry — the orchestrator
 * computed it as what the step would carry had the camera been elected onto
 * that device (its per-(node,device) base with the camera's override for it).
 * A step absent from the map runs with neither, i.e. the target format's
 * default model. The elected device's provisioning never follows a step across:
 * it was chosen for a format this subtree does not run on.
 */
export function provisionSubtreeForDevice(
  step: PipelineStepInputOutput,
  provisioning: Readonly<Record<string, RunnerJumpStepProvisioning>>,
): PipelineStepInputOutput {
  const own = provisioning[step.addonId]
  // Every other field of the step travels as sent; only the two the target
  // provisions are dropped, then set from the target's entry.
  const { modelId: _electedModelId, settings: _electedSettings, ...rest } = step
  return {
    ...rest,
    ...(own?.modelId !== undefined ? { modelId: own.modelId } : {}),
    ...(own?.settings !== undefined ? { settings: own.settings } : {}),
    ...(step.children !== undefined
      ? { children: step.children.map((c) => provisionSubtreeForDevice(c, provisioning)) }
      : {}),
  }
}

export interface PlaceDetailStepInput {
  /** The top-level enrichment step, as the attach provisioned it for the ELECTED device. */
  readonly step: PipelineStepInputOutput
  /** The camera's elected device; absent ⇒ the runner's default pool. */
  readonly effectiveDeviceKey: string | undefined
  /** The attach's same-node roster (`RunnerCameraConfig.inferenceDevices`). */
  readonly roster: readonly RunnerInferenceDevice[] | undefined
  /** Live attached-camera count per deviceKey on this runner. */
  readonly attachedByKey: ReadonlyMap<string, number>
  readonly getStepDef: (addonId: string) => StepDefinition | null
}

/** Where a detail subtree runs, and with what. `decision` is null when there was nothing to decide. */
export interface DetailStepPlacement {
  readonly deviceKey: string | undefined
  readonly step: PipelineStepInputOutput
  readonly decision: ResolveStepDeviceResult | null
  /**
   * A jumped subtree was re-provisioned from the target's roster entry (D650).
   * `false` on a jump means the roster carried no `steps` (an orchestrator, or
   * a `@camstack/types` closure, that predates D650): the step runs as sent,
   * with the elected device's provisioning.
   */
  readonly provisioned: boolean
}

/** The subtree as `deviceKey` would run it: the elected device runs it as sent; another takes its roster entry. */
function provisionedFor(
  step: PipelineStepInputOutput,
  deviceKey: string,
  effectiveDeviceKey: string,
  roster: readonly RunnerInferenceDevice[],
): PipelineStepInputOutput {
  if (deviceKey === effectiveDeviceKey) return step
  const provisioning = roster.find((d) => d.deviceKey === deviceKey)?.steps
  return provisioning === undefined ? step : provisionSubtreeForDevice(step, provisioning)
}

/**
 * Place ONE detail subtree (D650): which same-node device runs it
 * ({@link resolveStepDevice}) and, when it jumps, the provisioning it runs
 * with there ({@link provisionSubtreeForDevice}). Pure — the caller logs.
 *
 * A roster entry without `steps` came from an orchestrator that predates D650:
 * the step keeps what it was sent with, as it did before.
 */
export function placeDetailStep(input: PlaceDetailStepInput): DetailStepPlacement {
  const { step, effectiveDeviceKey, roster } = input
  // No elected device (single default pool) ⇒ nothing to jump between.
  if (!effectiveDeviceKey) return { deviceKey: undefined, step, decision: null, provisioned: false }
  // Roster absent / single entry ⇒ no jump target; run on the elected device.
  if (!roster || roster.length < 2) {
    return { deviceKey: effectiveDeviceKey, step, decision: null, provisioned: false }
  }

  const decision = resolveStepDevice({
    effectiveDeviceKey,
    devices: roster.map((d) => ({
      deviceKey: d.deviceKey,
      weight: d.weight,
      maxSessions: d.maxSessions,
      attachedCameras: input.attachedByKey.get(d.deviceKey) ?? 0,
    })),
    ...(step.jumpDeviceKey !== undefined ? { manualJumpDeviceKey: step.jumpDeviceKey } : {}),
    // The step AND its enabled children ride the same call (one pool, one
    // format), so the predicate covers the whole subtree — and each candidate
    // is judged with the model IT would run (D657): its own roster entry when
    // it carries one, else the step as sent.
    canRun: (format, deviceKey) =>
      buildSubtreeCanRun(
        provisionedFor(step, deviceKey, effectiveDeviceKey, roster),
        input.getStepDef,
      )(format),
  })
  if (decision.kind !== 'jumped') {
    return { deviceKey: decision.deviceKey, step, decision, provisioned: false }
  }

  const provisioning = roster.find((d) => d.deviceKey === decision.deviceKey)?.steps
  return {
    deviceKey: decision.deviceKey,
    step: provisioning === undefined ? step : provisionSubtreeForDevice(step, provisioning),
    decision,
    provisioned: provisioning !== undefined,
  }
}

/** Result of {@link stepsForElectedPool}. */
export interface ElectedPoolSteps {
  /** The tree the camera's FRAME-plane dispatch carries to its elected pool. */
  readonly steps: PipelineStepInputOutput[]
  /** Top steps of the detail subtrees left out: they run on another device, or on none. */
  readonly delegated: readonly string[]
}

/**
 * The steps whose models a camera's elected pool loads (D657).
 *
 * The frame-plane dispatch executes only root-plane steps; a detail subtree
 * rides it solely so its model pre-warms the elected pool. That is right only
 * when the subtree RUNS there. The decision is {@link placeDetailStep}'s — the
 * one the detail plane takes for the same subtree — so the pool that loads a
 * model and the pool that runs it cannot disagree:
 *  - no decision (no elected device, or a roster of one) or `no-jump`: kept;
 *  - `jumped` (auto or manual): left out — the detail dispatch loads it on the
 *    TARGET pool, with the target's provisioning;
 *  - `no-candidate`: left out — nothing on the node can load it, so a
 *    pre-warm could only fail (the detail plane still says so, loudly).
 * Roots are the elected device's job and always stay. Root-plane children
 * stay and are walked; a detail subtree is judged whole at its top, because
 * its children ride its call. Pure — the caller logs.
 */
export function stepsForElectedPool(
  steps: readonly PipelineStepInputOutput[],
  isDetailStep: (addonId: string) => boolean,
  place: (step: PipelineStepInputOutput) => DetailStepPlacement,
): ElectedPoolSteps {
  const delegated: string[] = []
  const walk = (
    nodes: readonly PipelineStepInputOutput[],
    topLevel: boolean,
  ): PipelineStepInputOutput[] => {
    const kept: PipelineStepInputOutput[] = []
    for (const step of nodes) {
      if (!topLevel && step.enabled !== false && isDetailStep(step.addonId)) {
        const decision = place(step).decision
        if (decision === null || decision.kind === 'no-jump') kept.push(step)
        else delegated.push(step.addonId)
        continue
      }
      kept.push(
        step.children !== undefined && step.children.length > 0
          ? { ...step, children: walk(step.children, false) }
          : step,
      )
    }
    return kept
  }
  return { steps: walk(steps, true), delegated }
}
