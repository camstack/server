/**
 * Per-device default object-detection model + deviceKey parsing for the
 * orchestrator's device-aware `getNodeInferenceDevices` view.
 *
 * This DUPLICATES the executor's per-device model resolution (P0-3:
 * `resolveDeviceEngine` + `MODEL_BY_CLASS` + the object-detection step's
 * `defaultModelIdByFormat` in `@camstack/addon-pipeline`). It is duplicated —
 * not imported — because cross-addon imports are forbidden (the orchestrator
 * and the detection-pipeline are separate addons; only tRPC crosses the
 * boundary). Keep this in sync with `default-detection-model.ts` /
 * `step-definitions.ts` if the executor's defaults change.
 *
 * The returned ids are honest catalog ids (verified present):
 *   - `yolov9m-320-int8` — Intel NPU + iGPU (YOLO26 runs on the NPU too, but is
 *                          an operator pick there, not the default)
 *   - `yolov9m-320`      — Apple ANE (CoreML)
 *   - `yolov9s-320-edgetpu` — Coral Edge TPU (tflite; D908)
 *   - `yolo26n`          — CPU / CUDA (the object-detection step's universal
 *                          nano default)
 *
 * Do not promote the accelerated ids to 640. The evaluation in
 * `docs/benchmarks/pipeline-frame-model-eval.md` failed the 640 promotion
 * gates (0/3 miss recovered at the current threshold).
 */
import {
  type InferenceDeviceExclusionReason as CapInferenceDeviceExclusionReason,
  type DeviceStepConfig,
  deviceBackendToFormat,
  type InferenceDeviceDescriptor,
  type ModelFormat,
  type PipelineSchema,
  type RunnerInferenceDevice,
} from '@camstack/types'
import { addonHasCompatibleModel, OBJECT_DETECTION_STEP_ID } from './pipeline-resolver.js'

/**
 * Build the camera-root capability predicate for a node from its live catalog:
 * `format → canHostCameraRoot`. A format can host a camera root iff the
 * catalog lists at least one object-detection model with a build for that
 * format — it IS the resolver's per-device skip-gate test for the root step
 * (`addonHasCompatibleModel`), so a device is deemed eligible iff the root
 * would ACTUALLY provision on it. The root is {@link OBJECT_DETECTION_STEP_ID},
 * shared with the resolver's refusal backstop (`droppedRoots`) so the two gates
 * judge the same step (D650 round 4).
 *
 * Fails OPEN when the catalog has no object-detection slot at all (never
 * observed in production) so a malformed/empty catalog never strands every
 * device off the balancer. Pure + deterministic.
 */
export function makeRootCapabilityGuard(catalog: PipelineSchema): (format: string) => boolean {
  for (const slot of catalog.slots) {
    const objDet = slot.addons.find((a) => a.id === OBJECT_DETECTION_STEP_ID)
    if (objDet) {
      return (format: string): boolean => addonHasCompatibleModel(objDet, format)
    }
  }
  return () => true
}

/** Split a deviceKey (`<backend>:<device>`, or bare `cpu`) into its parts + format.
 *  Format comes from the shared {@link deviceBackendToFormat} SSOT (`@camstack/types`)
 *  — the previously-local `BACKEND_FORMAT` copy is gone (R3/node-F2). Used only for
 *  STORED-ONLY keys (a configured device the live probe didn't return); a probed
 *  device carries its own honest `format` from the descriptor. */
export function parseDeviceKey(deviceKey: string): {
  readonly backend: string
  readonly device: string
  readonly format: ModelFormat
} {
  const colon = deviceKey.indexOf(':')
  const backend = colon >= 0 ? deviceKey.slice(0, colon) : deviceKey
  const device = colon >= 0 ? deviceKey.slice(colon + 1) : deviceKey
  return { backend, device, format: deviceBackendToFormat(backend) }
}

/**
 * The object-detection model the executor defaults to for a deviceKey. Mirrors
 * the executor's `MODEL_BY_CLASS` classification (`classifyAccelerator`) plus
 * the tflite `defaultModelIdByFormat` for Coral. Never throws; unknown backends
 * fall back to the universal nano default (`yolo26n`).
 */
export function defaultModelIdForDevice(deviceKey: string): string {
  const { backend } = parseDeviceKey(deviceKey)

  // OpenVINO — NPU/iGPU and the AMD Zen4 CPU pin all take the int8 IR
  // (`yolov9m-320-int8`). `openvino:cpu` is enumerated on AMD only; on Intel
  // it is never emitted (the universal `cpu` floor covers ORT-CPU).
  if (backend === 'openvino') {
    return 'yolov9m-320-int8'
  }
  // Coral Edge TPU — YOLOv9-s @320 (D908; yolo26 has no tflite build).
  if (backend === 'edgetpu') return 'yolov9s-320-edgetpu'
  // Apple CoreML (ANE) — our CoreML yolov9 @320.
  if (backend === 'coreml') return 'yolov9m-320'
  // onnx / cpu / cuda / anything else → the step's universal nano default.
  return 'yolo26n'
}

/** A node's stored per-device opt-OUT entry (`inferenceDevices[deviceKey]`). */
export interface StoredInferenceDevice {
  readonly enabled: boolean
  readonly weight?: number
  readonly maxSessions?: number
  /** Per-(node,device) BASE provisioning (C7.2/C7.4): `stepId → {modelId?, settings?}`. */
  readonly steps?: Readonly<Record<string, DeviceStepConfig>>
}

/**
 * Step-tree device jump (phase 1): validate every `steps[step].jumpDeviceKey`
 * manual override in a to-be-saved `inferenceDevices` map. A jump target MUST be
 * an enabled∧available device on the SAME node and DIFFERENT from the owning
 * device. `enabledAvailableKeys` is the effective enabled∧available set (from
 * `mergeInferenceDevices(probe, submitted)`) so an absent/unplugged/disabled
 * target is rejected honestly (an operator can't route a step onto a dead pool).
 * Returns the FIRST human-readable error, or `null` when every override is
 * valid. Pure + deterministic.
 */
export function validateJumpTargets(
  inferenceDevices: Readonly<Record<string, StoredInferenceDevice>>,
  enabledAvailableKeys: ReadonlySet<string>,
): string | null {
  for (const [deviceKey, entry] of Object.entries(inferenceDevices)) {
    for (const [stepId, step] of Object.entries(entry.steps ?? {})) {
      const target = step.jumpDeviceKey
      if (target === undefined) continue
      if (target === deviceKey) {
        return `step "${stepId}" on "${deviceKey}" has a jumpDeviceKey pointing at its own device`
      }
      if (!enabledAvailableKeys.has(target)) {
        return `step "${stepId}" on "${deviceKey}" has a jumpDeviceKey "${target}" that is not an enabled, available device on this node`
      }
    }
  }
  return null
}

/**
 * Is a device on the node at all (D919)? `present` — the probe reported it;
 * `absent` — the probe answered without it (only stored settings remain);
 * `unknown` — the probe did not answer, so nothing is claimed (D315).
 */
export type InferenceDevicePresence = 'present' | 'absent' | 'unknown'

/** The fully-merged per-device view row (matches `NodeInferenceDevice`). */
export interface InferenceDeviceView {
  readonly key: string
  readonly backend: string
  readonly device: string
  readonly format: ModelFormat
  readonly available: boolean
  /**
   * `present` when the probe reported the key, `absent` for a stored-only
   * key. The merge cannot know whether the probe ANSWERED; the caller that
   * does (`getNodeInferenceDevices`) turns `absent` into `unknown` when not.
   */
  readonly presence: InferenceDevicePresence
  readonly enabled: boolean
  readonly weight: number
  readonly maxSessions: number | null
  readonly defaultModelId: string
  /** RAW stored per-(node,device) BASE provisioning (C7.2/C7.4), omitted when none. */
  readonly steps?: Readonly<Record<string, DeviceStepConfig>>
}

/**
 * Merge a node's live-probed inference devices with its stored per-device map.
 *
 * The default is **AUTO = all discovered ACCELERATORS enabled** (spec C2,
 * opt-OUT) with TWO deliberate exceptions, both **opt-IN** (default disabled):
 *
 *   - **CPU floor (`cpu`)**: `enumerateInferenceDevices` always emits a
 *     universal `cpu` key on every platform; auto-enabling it would let the
 *     balancer round-robin ~1/N of sessions onto the slow CPU pool alongside
 *     the NPU/iGPU/ANE. CPU stays the always-available FALLBACK (a node with
 *     no eligible accelerator leaves `deviceKey` unset → the runner's default
 *     pool, which is CPU), not a balanced target — matching the spec's "no
 *     device eligible → fall back to CPU".
 *   - **Any `*:cpu` device** (today `openvino:cpu` on AMD): still a CPU
 *     pool — Zen4 VNNI serving int8 IRs — not an accelerator. Auto-enabling
 *     it next to `onnx:webgpu` would steal sessions from the iGPU the same
 *     way the bare `cpu` floor would. Intel never emits `openvino:cpu`
 *     (NPU/iGPU cover the IR format); AMD does, so the device-string rule
 *     keeps both CPU-class keys opt-IN.
 *
 * A **Coral Edge TPU (`edgetpu`)** is an accelerator like the rest and is
 * enabled by default (D912, superseding D39). The 2026-08-01 incident that made
 * it opt-in (a Coral nobody enabled took an equal share of the rotation, ran a
 * weaker SSD and left camera 101 at 2.4 fps) is answered by speed-proportional
 * automatic weights — Auto tune sizes the Coral at its default YOLOv9-s 320
 * Edge TPU build with the measured latency — and by that default model, which
 * is YOLOv9 like the rest. An explicit stored `enabled:false` still wins.
 *
 * So: an NPU/iGPU/ANE/WebGPU accelerator with NO stored entry is
 * `enabled:true` (a Coral included); a CPU-class device with no stored entry is
 * `enabled:false`; an explicit stored `enabled` always wins (an operator can
 * opt CPU in, or an accelerator/Coral out). A stored-only key (configured but
 * the probe did not return it — removed/unplugged HW) keeps its stored
 * `enabled` and surfaces as `available:false`, `presence:'absent'`, so the UI
 * shows it as ABSENT with its settings and a way to forget it (D919). It is
 * never eligible, whatever its stored `enabled`: eligibility needs `available`.
 *
 * Pure + deterministic (sorted by key) — the single merge authority shared by
 * the `getNodeInferenceDevices` view and the dispatcher's eligible-device pick.
 */
export function mergeInferenceDevices(
  probed: readonly InferenceDeviceDescriptor[],
  stored: Readonly<Record<string, StoredInferenceDevice>>,
): InferenceDeviceView[] {
  const probedByKey = new Map(probed.map((d) => [d.key, d]))
  const keys = new Set<string>([...probedByKey.keys(), ...Object.keys(stored)])
  const out: InferenceDeviceView[] = []
  for (const key of Array.from(keys).toSorted()) {
    const descriptor = probedByKey.get(key)
    const opt = stored[key]
    const parsed = descriptor ?? parseDeviceKey(key)
    const weight = opt?.weight !== undefined && opt.weight > 0 ? opt.weight : 1
    // CPU-class devices (`cpu`, `openvino:cpu`, …) are opt-IN (default off —
    // see the module doc); every other accelerator, a Coral included (D912),
    // is opt-OUT (default on).
    const autoDefault = parsed.backend !== 'cpu' && parsed.device !== 'cpu'
    out.push({
      key,
      backend: parsed.backend,
      device: parsed.device,
      format: parsed.format,
      available: descriptor?.available ?? false,
      presence: descriptor === undefined ? 'absent' : 'present',
      enabled: opt?.enabled ?? autoDefault,
      weight,
      maxSessions: opt?.maxSessions ?? null,
      defaultModelId: defaultModelIdForDevice(key),
      // C7.2/C7.4 per-(node,device) BASE provisioning — surface the RAW stored
      // map so the UI shows the current selection (base ?? default). Omitted
      // when the key carries no base.
      ...(opt?.steps && Object.keys(opt.steps).length > 0 ? { steps: { ...opt.steps } } : {}),
    })
  }
  return out
}

/**
 * The per-device concurrent-session caps for a node as `deviceKey → maxSessions`
 * (only devices that carry an explicit cap; absent = unlimited). Fed to the
 * device balancer's `nodeCaps` so a device at its cap is skipped (audit F3).
 */
export function inferenceDeviceCaps(
  stored: Readonly<Record<string, StoredInferenceDevice>>,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, entry] of Object.entries(stored)) {
    if (entry.maxSessions !== undefined && entry.maxSessions > 0) out[key] = entry.maxSessions
  }
  return out
}

/**
 * Why a device the node HAS is not a candidate for the camera-root election.
 *
 * The reason list is the CAP CONTRACT (`INFERENCE_DEVICE_EXCLUSION_REASONS` in
 * `@camstack/types`) rather than a local union, because it is now RENDERED:
 * `getNodeInferenceDevices` carries it per device so the admin UI names the
 * reason an enabled accelerator is not being used instead of leaving the
 * operator to deduce it. A local copy would drift the moment one side gains a
 * reason.
 *
 * The four:
 *  - `disabled`  — the operator turned it off (CPU/edgetpu are opt-IN).
 *  - `unavailable` — the live probe did not report it (unplugged/provisioning).
 *  - `cannot-host-camera-root` — its engine format can't run the root detector.
 *  - `accelerator-preferred` — it is the CPU FALLBACK and a real accelerator is
 *    serving this node. Weight cannot express "last resort": the balancer
 *    minimises `capacityScore / weight`, so a momentarily-idle weight-1 CPU
 *    scores 0 and beats any loaded accelerator. With ephemeral on-motion
 *    sessions the CPU is idle at nearly every decision — measured 2026-08-21,
 *    it took 188 of 428 dispatches in ten minutes (44%, where its weight said
 *    ~1%) and drove the hub's ONNX pool to 647% CPU. So the rule lives here,
 *    not in the weight: while an accelerator can host the root, the CPU is not
 *    a candidate. (D215)
 */
export type InferenceDeviceExclusionReason = CapInferenceDeviceExclusionReason

/** One device dropped from the candidate set, with the reason it was dropped. */
export interface InferenceDeviceExclusion {
  readonly key: string
  readonly reason: InferenceDeviceExclusionReason
  readonly format: ModelFormat
}

/**
 * The dispatcher-facing candidate set for a node, WITH the devices that were
 * dropped and why.
 *
 * `eligible` is the enabled AND available devices as a `deviceKey → weight` map
 * (the balancer input). A device the operator disabled, or one the probe
 * reports unavailable (unplugged / still provisioning), is excluded — so a
 * session never lands on a dead pool (audit F4). Fewer than two entries ⇒ the
 * caller leaves `deviceKey` unset and the runner uses its single default
 * accelerator.
 *
 * `canRunRoot` (optional) additionally EXCLUDES any device whose engine format
 * cannot run the object-detection camera root — see {@link makeRootCapabilityGuard}.
 * A device that can't host the root (e.g. a pre-provisioned Coral before its
 * tflite model reaches the catalog, or an enrichment-only NPU) must never be
 * elected as a camera's root device; the runner auto-jumps enrichment steps
 * onto it instead. Omitted (no catalog available yet) ⇒ fail-open, matching the
 * lenient cold-start behaviour elsewhere. A device the guard rejects is also
 * never a valid pin target: `pickInferenceDevice` passes the eligible keys as
 * `eligibleNodes`, and `balance()` never assigns a node outside that set — so a
 * pin to a root-incapable key is silently ignored (CPU default serves it).
 *
 * `excluded` exists because every one of those three drops used to be SILENT.
 * A device that quietly vanishes from the candidate set is indistinguishable
 * from a device that was never there, and "the accelerator is enabled but no
 * session ever lands on it" has exactly those two shapes. The caller logs this
 * (see `resolveEligibleInferenceDevices` in `index.ts`); the function itself
 * stays pure and deterministic (sorted by key, via {@link mergeInferenceDevices}).
 */
export interface InferenceDeviceEligibility {
  readonly eligible: Record<string, number>
  readonly excluded: readonly InferenceDeviceExclusion[]
}

/** Is this device the CPU fallback rather than a real accelerator? */
function isCpuFallback(view: { readonly backend: string }): boolean {
  return view.backend === 'cpu'
}

export function resolveInferenceDeviceEligibility(
  probed: readonly InferenceDeviceDescriptor[],
  stored: Readonly<Record<string, StoredInferenceDevice>>,
  canRunRoot?: (format: string) => boolean,
  isPoolUsable?: (deviceKey: string) => boolean,
): InferenceDeviceEligibility {
  const eligible: Record<string, number> = {}
  const excluded: InferenceDeviceExclusion[] = []
  const merged = mergeInferenceDevices(probed, stored)
  // Computed BEFORE the loop and over the same predicates the loop applies, so
  // "an accelerator is serving this node" means exactly what the election means
  // by it — including the root-capability guard: a Coral that cannot host the
  // camera root is not an accelerator this node can place a camera on, and must
  // not suppress the fallback (that would leave the node with no root device).
  //
  // `isPoolUsable` is deliberately NOT one of those predicates. A node whose
  // every accelerator POOL has died must not quietly promote the CPU into the
  // rotation: D215 measured what that costs (188 of 428 dispatches in ten
  // minutes onto a weight-1 CPU, the ONNX pool at 647%), and a node that keeps
  // absorbing cameras on a degraded fallback never leaves the placement set, so
  // the healthy accelerators on OTHER nodes are never used. Leaving the CPU
  // suppressed makes the node run out of eligible devices, which is precisely
  // what tips `resolveNodeInferenceUsability` into "not usable" and moves the
  // cameras. Refusing loudly beats degrading silently.
  const acceleratorServes = merged.some(
    (d) => !isCpuFallback(d) && d.enabled && d.available && (!canRunRoot || canRunRoot(d.format)),
  )
  for (const d of merged) {
    // Order matters and is reported first-reason-wins: an operator-disabled
    // device reads as 'disabled' even when it is also unplugged, because
    // re-enabling it is the action that changes anything.
    if (!d.enabled) {
      excluded.push({ key: d.key, reason: 'disabled', format: d.format })
      continue
    }
    if (!d.available) {
      excluded.push({ key: d.key, reason: 'unavailable', format: d.format })
      continue
    }
    // The hardware is there and the operator wants it, but the executor on that
    // node refuses to run inference on it — its Python pool died and its restart
    // budget is spent (or is backing off). Same reason word as the probe drop:
    // `unavailable` is documented as "the live probe did not report it as
    // usable", and a pool that cannot answer a frame is exactly that, arriving
    // from the only component that can tell (the format-keyed capability gate
    // cannot — `openvino:gpu` and `openvino:npu` share a format).
    //
    // Reusing the word is also what makes the node tier work for free:
    // `resolveNodeInferenceUsability` counts `unavailable` exclusions, so a node
    // whose every enabled accelerator pool is dead becomes node-unusable and its
    // cameras are placed on another node, instead of rotating onto a corpse.
    if (isPoolUsable && !isPoolUsable(d.key)) {
      excluded.push({ key: d.key, reason: 'unavailable', format: d.format })
      continue
    }
    if (canRunRoot && !canRunRoot(d.format)) {
      excluded.push({ key: d.key, reason: 'cannot-host-camera-root', format: d.format })
      continue
    }
    // Last, and only for the fallback: an enabled CPU stays configured (it is
    // the safety net for the day the accelerators go) but never competes while
    // one of them is serving. See `'accelerator-preferred'`.
    if (isCpuFallback(d) && acceleratorServes) {
      excluded.push({ key: d.key, reason: 'accelerator-preferred', format: d.format })
      continue
    }
    eligible[d.key] = d.weight
  }
  return { eligible, excluded }
}

/**
 * One merged device view PLUS the reason the dispatcher drops it (or `null`
 * when it is a candidate) — the shape `getNodeInferenceDevices` returns.
 */
export interface InferenceDeviceViewWithExclusion extends InferenceDeviceView {
  readonly exclusion: InferenceDeviceExclusionReason | null
}

/**
 * Join the merged device rows with the eligibility verdict so the UI can NAME
 * why an accelerator is not in play instead of leaving the operator to deduce
 * it from `enabled`/`available`.
 *
 * Deduction is not possible for two of the four reasons — `accelerator-preferred`
 * is a node-WIDE rule (a CPU row reads `enabled:true, available:true` and still
 * never gets a session, D215) and `cannot-host-camera-root` needs the node's
 * model catalog. Both live in {@link resolveInferenceDeviceEligibility}, so this
 * function only transports its answer; it never re-derives one.
 *
 * Pure; preserves `merged`'s order (sorted by key) and every other field.
 */
export function annotateInferenceDeviceExclusions(
  merged: readonly InferenceDeviceView[],
  eligibility: InferenceDeviceEligibility,
): InferenceDeviceViewWithExclusion[] {
  const reasonByKey = new Map(eligibility.excluded.map((e) => [e.key, e.reason]))
  return merged.map((view) => ({ ...view, exclusion: reasonByKey.get(view.key) ?? null }))
}

/**
 * Is a node still able to run inference at all?
 *
 * The distinction this makes, and the reason it is not simply
 * `Object.keys(eligible).length === 0`:
 *
 *  - a node with NO accelerator configured has zero eligible devices and is
 *    perfectly healthy — its devices are excluded as `disabled` (cpu is
 *    opt-IN) and the runner's default CPU pool serves every camera on it.
 *    That is the normal shape of most installs, and excluding it from
 *    placement would empty the cluster.
 *  - a node where the operator ENABLED accelerators and the live probe now
 *    reports every one of them missing is broken in a way nothing else
 *    notices: it stays online, keeps answering, keeps being handed cameras,
 *    and fails every inference. agent-a absorbed 283 000 errors in a
 *    single day in exactly that state.
 *
 * So the predicate is `nothing eligible AND at least one enabled device is
 * UNAVAILABLE`. `cannot-host-camera-root` deliberately does not count: a
 * root-incapable accelerator (a Coral awaiting its tflite model) still leaves
 * the CPU default able to serve the camera.
 */
export interface NodeInferenceUsability {
  readonly usable: boolean
  /** Enabled device keys the live probe did not report — the evidence. */
  readonly unavailableKeys: readonly string[]
  readonly eligibleKeys: readonly string[]
}

export function resolveNodeInferenceUsability(
  eligibility: InferenceDeviceEligibility,
): NodeInferenceUsability {
  const eligibleKeys = Object.keys(eligibility.eligible).toSorted()
  const unavailableKeys = eligibility.excluded
    .filter((e) => e.reason === 'unavailable')
    .map((e) => e.key)
    .toSorted()
  return {
    usable: eligibleKeys.length > 0 || unavailableKeys.length === 0,
    unavailableKeys,
    eligibleKeys,
  }
}

/**
 * Step-tree device jump (phase 1): the attach-payload roster of a node's
 * enabled∧available inference devices with the balancer knobs (`weight`,
 * `maxSessions`) the runner uses to AUTO-jump an enrichment step off a device
 * whose format can't run it. Built from the SAME `eligible` (deviceKey→weight)
 * and `caps` (deviceKey→maxSessions) the dispatcher already computes, so the
 * roster the runner sees exactly matches the balancer's candidate set. Sorted
 * by key for determinism. Populated onto `RunnerCameraConfig.inferenceDevices`
 * ONLY when a `deviceKey` is elected and there are ≥2 entries.
 */
export function buildInferenceDeviceRoster(
  eligible: Readonly<Record<string, number>>,
  caps: Readonly<Record<string, number>>,
): RunnerInferenceDevice[] {
  return Object.entries(eligible)
    .map(
      ([deviceKey, weight]): RunnerInferenceDevice => ({
        deviceKey,
        weight: weight > 0 ? weight : 1,
        maxSessions: caps[deviceKey] ?? null,
      }),
    )
    .toSorted((a, b) => (a.deviceKey < b.deviceKey ? -1 : a.deviceKey > b.deviceKey ? 1 : 0))
}
