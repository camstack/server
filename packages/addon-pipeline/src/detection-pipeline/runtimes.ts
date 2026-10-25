// Hardware-driven Runtime Registry — detection-pipeline local view.
//
// Support/devices/format rules are DELEGATED to `@camstack/types`
// (`inference/runtime-capabilities`), which is the single source of truth.
// This module retains ONLY the detection-specific per-runtime data:
//   - `pythonRequirements`: the requirements files to install
//   - `tuning`: inference-pool knobs (concurrency, batchMode, …)
//
// Callers continue to import `supportedRuntimes`, `runtimeDevices`,
// `defaultDeviceFor`, `RuntimeId`, `DeviceOption` from here without change —
// they are re-exported (or thin adapters) forwarding to the shared rules.

import {
  supportedRuntimes as sharedSupportedRuntimes,
  runtimeDevices as sharedRuntimeDevices,
  defaultDeviceFor as sharedDefaultDeviceFor,
  type RuntimeId,
  type DeviceOption,
} from '@camstack/types'
import type { HardwareInfo, GpuInfo, NpuInfo, CoralInfo } from '@camstack/types'
import type { PoolBatchMode, PoolTuning } from './engine/shared-inference-pool.js'

// ---------------------------------------------------------------------------
// Re-export shared types so existing importers keep working
// ---------------------------------------------------------------------------

export type { RuntimeId, DeviceOption, PoolBatchMode }

/**
 * The COMPLETE provisioning of one inference pool of a given runtime: the
 * Python-side worker thread count (`concurrency`), the number of independent
 * pool subprocesses (`numWorkers`), and the batch-dispatch tuning.
 *
 * Every field is required. The former `Record<string, number | string>` bag let
 * a missing key fall through to whatever default the reader happened to carry,
 * which is how `openvino` ended up running with `onnx`'s numbers: the defaults
 * lived in two places (this table AND `engine-factory`) and only one of them was
 * keyed by the pool's own runtime.
 */
export interface RuntimePoolProfile extends PoolTuning {
  /** Python-side prepare/predict thread-pool size inside ONE pool subprocess. */
  readonly concurrency: number
  /** Independent Python pool subprocesses. RAM scales linearly with this. */
  readonly numWorkers: number
}

// ---------------------------------------------------------------------------
// Local adapter types
//
// `ProbedHardware` and `RuntimeEnv` are thin local shapes used throughout this
// package. They intentionally carry only the fields the hardware-detection logic
// needs (npu/gpu, platform, arch). The shared rules take `HardwareInfo | null`
// directly; the two helpers below bridge the gap without touching call sites.
// ---------------------------------------------------------------------------

export interface ProbedHardware {
  readonly npu: { readonly type: string } | null
  readonly gpu: { readonly type: string } | null
  /**
   * Coral Edge TPU hardware (USB and/or PCIe), WHOLE — its usable `units` are
   * what the enumerator turns into `edgetpu:<bus>[:N]` devices.
   */
  readonly coral?: CoralInfo | null
}

export interface RuntimeEnv {
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly hardware: ProbedHardware | null
}

// ---------------------------------------------------------------------------
// Adapters: local shapes → HardwareInfo
//
// `HardwareInfo` requires cpuModel/cpuCores/RAM fields that the detection
// pipeline does not track. The shared rules only branch on platform, arch,
// gpu.type and npu.type, so the stub values below have no behavioural effect.
//
// Type narrowing: HardwareInfo['platform'] = 'darwin'|'linux'|'win32' and
// HardwareInfo['arch'] = 'arm64'|'x64'. NodeJS.Platform is a broader string
// union (includes 'win32', 'darwin', 'linux', …). We narrow at this boundary
// by falling back to 'linux' for any unrecognised value (never occurs at
// runtime: platform-probe produces only the three supported values).
// ---------------------------------------------------------------------------

const KNOWN_PLATFORMS = ['darwin', 'linux', 'win32'] as const
type KnownPlatform = (typeof KNOWN_PLATFORMS)[number]

const KNOWN_ARCHES = ['arm64', 'x64'] as const
type KnownArch = (typeof KNOWN_ARCHES)[number]

const KNOWN_GPU_TYPES = ['nvidia', 'amd', 'intel', 'apple'] as const
const KNOWN_NPU_TYPES = ['apple-ane', 'intel-npu', 'amd-xdna'] as const

function toKnownPlatform(p: string): KnownPlatform {
  return KNOWN_PLATFORMS.find((v) => v === p) ?? 'linux'
}

function toKnownArch(a: string): KnownArch {
  return KNOWN_ARCHES.find((v) => v === a) ?? 'x64'
}

function gpuInfoFrom(hw: ProbedHardware): GpuInfo | null {
  if (!hw.gpu) return null
  const type = KNOWN_GPU_TYPES.find((v) => v === hw.gpu?.type)
  if (!type) return null
  return { type, name: '' }
}

function npuInfoFrom(hw: ProbedHardware): NpuInfo | null {
  if (!hw.npu) return null
  const type = KNOWN_NPU_TYPES.find((v) => v === hw.npu?.type)
  if (!type) return null
  return { type }
}

function coralInfoFrom(hw: ProbedHardware): CoralInfo | null {
  return hw.coral?.type === 'coral-edgetpu' ? hw.coral : null
}

export function envToHardwareInfo(env: RuntimeEnv): HardwareInfo {
  // platform + arch are AUTHORITATIVE — they come from the running process
  // (`process.platform`/`arch`), which is deterministic and never wrong. They
  // are kept even when the async gpu/npu probe hasn't answered yet (gpu/npu
  // null) so the runtime pick is correct AT BOOT without waiting on the probe:
  // a darwin node is ALWAYS coreml-capable regardless of gpu detail. Only the
  // gpu/npu-dependent choices (openvino needs an Intel iGPU, cuda needs nvidia)
  // require the probe — and those nodes converge once the probe answers.
  return {
    platform: toKnownPlatform(env.platform),
    arch: toKnownArch(env.arch),
    cpuModel: '',
    cpuCores: 0,
    totalRAM_MB: 0,
    availableRAM_MB: 0,
    gpu: env.hardware ? gpuInfoFrom(env.hardware) : null,
    npu: env.hardware ? npuInfoFrom(env.hardware) : null,
    coral: env.hardware ? coralInfoFrom(env.hardware) : null,
  }
}

function probedToHardwareInfo(hw: ProbedHardware | null): HardwareInfo | null {
  if (!hw) return null
  return {
    platform: toKnownPlatform(process.platform),
    arch: toKnownArch(process.arch),
    cpuModel: '',
    cpuCores: 0,
    totalRAM_MB: 0,
    availableRAM_MB: 0,
    gpu: gpuInfoFrom(hw),
    npu: npuInfoFrom(hw),
    coral: coralInfoFrom(hw),
  }
}

// ---------------------------------------------------------------------------
// Detection-specific per-runtime data
// ---------------------------------------------------------------------------

interface RuntimeDetail {
  readonly label: string
  readonly pythonRequirements: readonly string[]
  readonly tuning: RuntimePoolProfile
}

/**
 * THE per-runtime pool provisioning registry — the single source for every
 * pool's concurrency / worker count / batch tuning, keyed by the runtime THAT
 * POOL runs. `engine-factory` used to carry a second, parallel copy of these
 * defaults; it no longer does.
 *
 * `windowMs` / `maxBatchSize` are inert unless `batchMode !== 'none'`, and
 * `numStreams` / `intraOpThreads` are inert at 0 (the runtime picks) — they are
 * still spelled out per row so a reader never has to guess which default a
 * missing key would have hit.
 *
 * `batchMode` / `maxBatchSize` are REQUEST GROUPING, not shape. Whether a graph
 * may keep a dynamic batch axis is a hardware fact derived at load from the
 * (engine, device) pair — `_static_batch_required` in `inference_pool.py`, D202 —
 * and appears nowhere in this registry, in the catalog, or in any operator knob.
 */
const RUNTIME_DETAIL: Record<RuntimeId, RuntimeDetail> = {
  onnx: {
    label: 'ONNX Runtime',
    pythonRequirements: ['requirements.txt', 'requirements-onnxruntime.txt'],
    // concurrency 4: `InferenceSession.run` is thread-safe and the native thread
    // pool schedules concurrent runs across cores (matrix sweep 2026-04-26).
    tuning: {
      concurrency: 4,
      numWorkers: 1,
      batchMode: 'list',
      windowMs: 2,
      maxBatchSize: 8,
      numStreams: 0,
      intraOpThreads: 0,
    },
  },
  openvino: {
    label: 'OpenVINO',
    pythonRequirements: ['requirements.txt', 'requirements-openvino.txt'],
    // concurrency 1 since 2026-06-24: OpenVINO manages its OWN infer-request
    // pool internally, so extra Python worker threads only add contention on the
    // one physical accelerator the pool is bound to (iGPU, NPU or CPU).
    tuning: {
      concurrency: 1,
      numWorkers: 1,
      batchMode: 'none',
      windowMs: 2,
      maxBatchSize: 8,
      numStreams: 0,
      intraOpThreads: 0,
    },
  },
  coreml: {
    label: 'CoreML',
    pythonRequirements: ['requirements.txt', 'requirements-coreml.txt'],
    // CoreML serialises per model context, so concurrency stays at 1.
    tuning: {
      concurrency: 1,
      numWorkers: 1,
      batchMode: 'none',
      windowMs: 8,
      maxBatchSize: 8,
      numStreams: 0,
      intraOpThreads: 0,
    },
  },
  edgetpu: {
    label: 'Coral Edge TPU',
    // LiteRT interpreter is pip-installed; the libedgetpu delegate is a native
    // library the deps downloader stages beside it (requirements-edgetpu.txt).
    pythonRequirements: ['requirements.txt', 'requirements-edgetpu.txt'],
    // The Coral is a single USB hardware context — all predicts serialise
    // through one delegate lock, so extra workers/batching add no throughput.
    // A second physical Coral is a SEPARATE pool (`edgetpu:usb:1`), each with
    // its own single worker; it is never more workers on one unit.
    tuning: {
      concurrency: 1,
      numWorkers: 1,
      batchMode: 'none',
      windowMs: 2,
      maxBatchSize: 8,
      numStreams: 0,
      intraOpThreads: 0,
    },
  },
}

// ---------------------------------------------------------------------------
// Public API — support/devices/format: delegate to shared rules
// ---------------------------------------------------------------------------

/**
 * Returns the list of supported runtime IDs for the given hardware env.
 * Delegates to `@camstack/types` `supportedRuntimes`.
 */
export function supportedRuntimes(env: RuntimeEnv): readonly RuntimeId[] {
  return sharedSupportedRuntimes(envToHardwareInfo(env))
}

/**
 * Returns the device options for a given runtime and probed hardware.
 * Delegates to `@camstack/types` `runtimeDevices`.
 */
export function runtimeDevices(
  id: RuntimeId,
  hardware: ProbedHardware | null,
): readonly DeviceOption[] {
  return sharedRuntimeDevices(id, probedToHardwareInfo(hardware))
}

/**
 * Returns the default device string for a given runtime.
 * Delegates to `@camstack/types` `defaultDeviceFor`.
 */
export function defaultDeviceFor(id: RuntimeId): string {
  return sharedDefaultDeviceFor(id)
}

/** Model format for each inference runtime supported by the detection pipeline. */
const RUNTIME_FORMAT: Record<RuntimeId, 'onnx' | 'openvino' | 'coreml' | 'tflite'> = {
  onnx: 'onnx',
  openvino: 'openvino',
  coreml: 'coreml',
  edgetpu: 'tflite',
}

/**
 * Returns the model format required for a given runtime.
 * Returns the locally-typed format string ('onnx' | 'openvino' | 'coreml' | 'tflite')
 * matching the engine-provisioner's own ModelFormat type.
 */
export function modelFormatFor(id: RuntimeId): 'onnx' | 'openvino' | 'coreml' | 'tflite' {
  return RUNTIME_FORMAT[id]
}

// ---------------------------------------------------------------------------
// Detection-specific accessors
// ---------------------------------------------------------------------------

export function pythonRequirementsFor(id: RuntimeId): readonly string[] {
  return RUNTIME_DETAIL[id].pythonRequirements
}

/**
 * The pool provisioning for ONE runtime. Callers must pass the runtime of the
 * pool they are provisioning — never the node's default runtime. See
 * `engine/pool-provisioning.ts` for the resolver that layers an operator
 * override on top of this.
 */
export function tuningFor(id: RuntimeId): RuntimePoolProfile {
  return RUNTIME_DETAIL[id].tuning
}

export function runtimeLabel(id: RuntimeId): string {
  return RUNTIME_DETAIL[id].label
}

/**
 * Proactive-install hint kept for back-compat (re-exported from index.ts).
 * Intel on Linux warrants OpenVINO for iGPU/NPU; AMD on Linux warrants it for
 * the CPU device (int8 IRs on Zen4 VNNI). coremltools covers macOS; NVIDIA
 * stays on ORT CUDA.
 */
export function shouldInstallOpenvino(env: {
  readonly platform: string
  readonly gpu: { readonly type: string } | null
  readonly npu: { readonly type: string } | null
}): boolean {
  if (env.platform === 'darwin') return false
  return env.gpu?.type === 'intel' || env.npu?.type === 'intel-npu' || env.gpu?.type === 'amd'
}

/**
 * Proactive-install hint for the ONNX WebGPU plugin EP (AMD iGPU on Linux).
 */
export function shouldInstallWebgpu(env: {
  readonly platform: string
  readonly gpu: { readonly type: string } | null
}): boolean {
  return env.platform === 'linux' && env.gpu?.type === 'amd'
}
