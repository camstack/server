/**
 * Pool provisioning — how ONE inference pool gets its worker count, its worker
 * threads and its batch tuning.
 *
 * ## Why this module exists
 *
 * A node runs a device-array of pools (`openvino:npu`, `openvino:gpu`,
 * `edgetpu:usb`, the `onnx` floor …). Every one of them used to be built with
 * the process-wide executor options that had been resolved ONCE for the node's
 * DEFAULT backend, so an `openvino` pool on an onnx-default node came up with
 * onnx's `concurrency: 4` — four Python threads contending on one iGPU, against
 * a registry that has said `openvino: 1` since 2026-06-24.
 *
 * ## Precedence — the whole rule, in order
 *
 *   1. **Operator override** — a non-auto value persisted on the detection
 *      addon's "Inference executor" settings. Node-wide: it applies to EVERY
 *      pool on the node, whatever runtime the pool runs, because that is what
 *      the operator asked for. Auto (`0` on a slider, `''` on the select) is
 *      NOT an override.
 *   2. **The per-runtime registry profile** — `tuningFor(<the pool's own
 *      runtime>)` in `runtimes.ts`. This is the only default; there is no third
 *      layer and no per-caller fallback.
 *
 * There is deliberately no per-DEVICE row (`openvino:npu` vs `openvino:gpu`).
 * The registry is matrix-derived and no sweep has been run per accelerator, so
 * every device of a runtime inherits that runtime's numbers. A device-level row
 * belongs here — {@link resolvePoolProvisioning} already receives the whole
 * engine — and must be backed by a bench, not a guess.
 */
import type { PipelineEngineChoice } from '@camstack/types'
import {
  tuningFor,
  type PoolBatchMode,
  type RuntimeId,
  type RuntimePoolProfile,
} from '../runtimes.js'

/**
 * An operator-set deviation from the registry profile. Every field optional;
 * `undefined` means "no override, use the runtime's registry value".
 */
export interface PoolProvisioningOverride {
  readonly concurrency?: number
  readonly numWorkers?: number
  readonly batchMode?: PoolBatchMode
  readonly windowMs?: number
  readonly maxBatchSize?: number
  readonly numStreams?: number
  readonly intraOpThreads?: number
}

/** The fields a {@link PoolProvisioningOverride} may carry, in table order. */
const OVERRIDABLE_KEYS = [
  'concurrency',
  'numWorkers',
  'batchMode',
  'windowMs',
  'maxBatchSize',
  'numStreams',
  'intraOpThreads',
] as const

export type PoolProvisioningKey = (typeof OVERRIDABLE_KEYS)[number]

/**
 * The resolved provisioning of one pool, plus the PROVENANCE of every value —
 * which fields the operator overrode. This replaces the old
 * `source: 'auto-default' | 'user-override'` log field, which described the
 * concurrency tuning but read as the provenance of the device/engine choice,
 * and was `'user-override'` on 100% of pools because the addon always passed
 * explicit tuning.
 */
export interface PoolProvisioning extends RuntimePoolProfile {
  /** The runtime whose registry row was used — the POOL's runtime, not the node's. */
  readonly runtime: RuntimeId
  /**
   * Fields taken from the operator override rather than the registry profile.
   * Empty ⇒ every value below is the runtime's registry default.
   */
  readonly overriddenFields: readonly PoolProvisioningKey[]
}

/** Backends that are not a runtime of their own and run on onnxruntime. */
const BACKEND_TO_RUNTIME: Readonly<Record<string, RuntimeId>> = {
  onnx: 'onnx',
  cpu: 'onnx',
  cuda: 'onnx',
  openvino: 'openvino',
  coreml: 'coreml',
  edgetpu: 'edgetpu',
}

/**
 * The registry runtime a device-pool backend provisions from. Unknown backends
 * floor to `onnx` — the same floor `resolveDeviceEngine` applies to the model
 * format, so a pool never comes up unprovisioned.
 */
export function runtimeIdForBackend(backend: string): RuntimeId {
  return BACKEND_TO_RUNTIME[backend] ?? 'onnx'
}

/**
 * Resolve the provisioning for a pool running `engine`, applying the precedence
 * documented at the top of this module. `engine.device` is not consulted today
 * (see the module doc) but is part of the signature so a bench-backed
 * per-device row lands here and nowhere else.
 */
export function resolvePoolProvisioning(
  engine: PipelineEngineChoice,
  override: PoolProvisioningOverride = {},
): PoolProvisioning {
  const runtime = runtimeIdForBackend(engine.backend)
  const profile = tuningFor(runtime)
  const overriddenFields = OVERRIDABLE_KEYS.filter((k) => override[k] !== undefined)
  return {
    runtime,
    overriddenFields,
    concurrency: Math.max(1, override.concurrency ?? profile.concurrency),
    numWorkers: Math.max(1, override.numWorkers ?? profile.numWorkers),
    batchMode: override.batchMode ?? profile.batchMode,
    windowMs: override.windowMs ?? profile.windowMs,
    maxBatchSize: override.maxBatchSize ?? profile.maxBatchSize,
    numStreams: override.numStreams ?? profile.numStreams,
    intraOpThreads: override.intraOpThreads ?? profile.intraOpThreads,
  }
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function batchMode(value: unknown): PoolBatchMode | undefined {
  return value === 'none' || value === 'list' || value === 'window' ? value : undefined
}

/**
 * The persisted "Inference executor" settings, as they arrive from the addon
 * config or from a raw settings store. Values are `unknown` because a store
 * blob is untrusted input — every field is narrowed below.
 */
export interface PoolProvisioningSettings {
  readonly concurrency?: unknown
  readonly numWorkers?: unknown
  readonly batchMode?: unknown
  readonly windowMs?: unknown
  readonly maxBatchSize?: unknown
  readonly numStreams?: unknown
  readonly intraOpThreads?: unknown
}

/**
 * Read the operator override out of the detection addon's settings. Only a
 * NON-AUTO value counts: the sliders persist `0` and the select persists `''`
 * for "Auto (backend default)", and those must resolve to the runtime's
 * registry value, not to a literal 0 worker threads.
 *
 * The result is deliberately sparse — an empty object means "nothing
 * overridden", which is what lets a per-device pool provision from its own
 * runtime instead of inheriting the node's.
 */
export function readOperatorOverride(settings: PoolProvisioningSettings): PoolProvisioningOverride {
  const override: {
    -readonly [K in PoolProvisioningKey]?: PoolProvisioning[K]
  } = {}
  const concurrency = positiveNumber(settings.concurrency)
  if (concurrency !== undefined) override.concurrency = concurrency
  const numWorkers = positiveNumber(settings.numWorkers)
  if (numWorkers !== undefined) override.numWorkers = numWorkers
  const mode = batchMode(settings.batchMode)
  if (mode !== undefined) override.batchMode = mode
  const windowMs = positiveNumber(settings.windowMs)
  if (windowMs !== undefined) override.windowMs = windowMs
  const maxBatchSize = positiveNumber(settings.maxBatchSize)
  if (maxBatchSize !== undefined) override.maxBatchSize = maxBatchSize
  const numStreams = positiveNumber(settings.numStreams)
  if (numStreams !== undefined) override.numStreams = numStreams
  const intraOpThreads = positiveNumber(settings.intraOpThreads)
  if (intraOpThreads !== undefined) override.intraOpThreads = intraOpThreads
  return override
}

/** Two overrides carry the same fields with the same values. */
export function overridesEqual(a: PoolProvisioningOverride, b: PoolProvisioningOverride): boolean {
  return OVERRIDABLE_KEYS.every((k) => a[k] === b[k])
}
