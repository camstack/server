import type { InferenceDeviceDescriptor } from '../inference/runtime-capabilities.js'
import type { AcceleratorCompute } from '../pipeline/auto-tune/accelerator-compute.js'

/** Hardware information detected at boot */
export interface HardwareInfo {
  readonly platform: 'darwin' | 'linux' | 'win32'
  readonly arch: 'arm64' | 'x64'
  readonly cpuModel: string
  readonly cpuCores: number
  readonly totalRAM_MB: number
  readonly availableRAM_MB: number
  readonly gpu: GpuInfo | null
  readonly npu: NpuInfo | null
  /**
   * Per-accelerator compute the probe reported (D930). Absent when the probe
   * did not run; an empty list means it ran and found no accelerator. A
   * failed field inside an entry is null, never 0.
   */
  readonly accelerators?: readonly AcceleratorCompute[]
  /**
   * Coral Edge TPU hardware (USB and/or PCIe), when found. Optional so existing
   * HardwareInfo construction sites and older cross-node probe reports stay
   * valid; absent / null ⇒ no Coral. Non-null with no usable unit (driver
   * missing, device not accessible) ⇒ the `edgetpu` runtime is withheld too.
   */
  readonly coral?: CoralInfo | null
}

export interface GpuInfo {
  readonly type: 'nvidia' | 'amd' | 'intel' | 'apple'
  readonly name: string
  readonly memoryMB?: number
}

export interface NpuInfo {
  readonly type: 'apple-ane' | 'intel-npu' | 'amd-xdna'
  /** Human-readable accelerator name (e.g. `Intel AI Boost NPU`), when known. */
  readonly name?: string
  /**
   * AMD XDNA generation when `type` is `amd-xdna`. Present-only until P2
   * offers a device key — Phoenix/Hawk Point are xdna1, Strix is xdna2.
   */
  readonly generation?: 'xdna1' | 'xdna2'
}

/** The bus a Coral Edge TPU sits on — libedgetpu's own device-family names. */
export type CoralBus = 'usb' | 'pci'

/** Usable Coral units on one bus: enumerated, and their device node opens. */
export interface CoralBusUnits {
  readonly bus: CoralBus
  readonly count: number
}

/**
 * Why a Coral that IS physically present cannot run (D393/D315: present but
 * unusable is never reported as absent).
 *  - `driver-missing`: the PCI function (`1ac1:089a`) is enumerated but no
 *    `/sys/class/apex/apex_N` exists — the gasket/apex kernel driver is not
 *    loaded on the host.
 *  - `device-not-accessible`: the driver is loaded but `/dev/apex_N` is absent
 *    from this process's view (not passed into the container) or cannot be
 *    opened read/write (permissions).
 */
export type CoralUnavailableReason = 'driver-missing' | 'device-not-accessible'

/** Present-but-unusable Coral units on one bus, with the typed reason. */
export interface CoralUnavailableUnits {
  readonly bus: CoralBus
  readonly count: number
  readonly reason: CoralUnavailableReason
}

/**
 * Coral Edge TPU (Google Coral), USB and/or PCIe/M.2. A discrete inference
 * accelerator that coexists with the host GPU/NPU (e.g. the Unraid hub carries
 * both an Intel NPU and a USB Coral). Tracked separately from {@link NpuInfo} so
 * its presence gates the `edgetpu` inference runtime without colliding with the
 * Intel-NPU signal.
 *
 * Non-null ⇒ Coral hardware was FOUND — usable or not. Only `units` (read
 * through `coralUsableUnits`) gates the runtime and the device keys; a unit in
 * `unavailable` is reported, never enumerated.
 */
export interface CoralInfo {
  readonly type: 'coral-edgetpu'
  /**
   * @deprecated Legacy single-bus report (older nodes). Read only through
   * `coralUsableUnits`, which falls back to it when `units` is absent.
   */
  readonly bus?: string
  /**
   * @deprecated Legacy USB unit count (older nodes); undefined ⇒ one Coral.
   * Read only through `coralUsableUnits`.
   */
  readonly count?: number
  /**
   * Usable units per bus. Each unit is its own concurrent pool — the enumerator
   * emits one device descriptor per unit (`edgetpu:usb`, `edgetpu:usb:1`,
   * `edgetpu:pci`, `edgetpu:pci:1`, …). Absent ⇒ a legacy report (see `bus`).
   */
  readonly units?: readonly CoralBusUnits[]
  /** Units that are present but cannot run, each with its typed reason. */
  readonly unavailable?: readonly CoralUnavailableUnits[]
}

/** A probed backend with availability and score */
export interface PlatformScore {
  readonly runtime: 'python'
  readonly backend: string
  readonly format: 'onnx' | 'coreml' | 'openvino' | 'tflite'
  readonly score: number
  readonly reason: string
  readonly available: boolean
}

/** Full platform capabilities — cached once per boot */
export interface PlatformCapabilities {
  readonly hardware: HardwareInfo
  readonly scores: readonly PlatformScore[]
  readonly bestScore: PlatformScore
  readonly pythonPath: string | null
  /** Every usable inference device on this node (enumerate, don't elect). */
  readonly devices: readonly InferenceDeviceDescriptor[]
}

/** Model requirement declared by an addon */
export interface ModelRequirement {
  readonly modelId: string
  readonly name: string
  /** Minimum RAM needed for inference (model + runtime overhead, in MB) */
  readonly minRAM_MB: number
  /** Relative accuracy score 0-100 */
  readonly accuracyScore: number
  /** Available formats in the model catalog */
  readonly formats: readonly string[]
}

/** Resolved config — the tripletta chosen by the scorer for an addon */
export interface ResolvedInferenceConfig {
  readonly modelId: string
  readonly runtime: 'python'
  readonly backend: string
  readonly format: import('../types/models.js').ModelFormat
  readonly reason: string
}
