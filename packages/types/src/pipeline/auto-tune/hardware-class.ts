/**
 * Static hardware classification for the Auto tune recommender (D745, D930).
 *
 * A node is classified from the facts its platform probe already reports —
 * `cpuModel`, `arch`, `gpu`, `npu` — never from a benchmark. The class picks a
 * column of the measured latency table (`detector-performance.ts`). A CPU that
 * matches no measured class is `unknown`: the recommender then scales from
 * reported accelerator compute when the probe supplied it, and leaves the
 * node alone only when it has neither.
 *
 * `cpuModel` is the host's CPU string even inside Docker (`os.cpus()`), which
 * is why it is the discriminator: "Intel(R) Core(TM) Ultra 7 265K",
 * "Intel(R) N100", "Apple M2", "Apple M3 Pro".
 */
import type { HardwareInfo } from '../../interfaces/platform.js'
import type { AcceleratorKind, HardwareClassId } from './plan-schemas.js'

/** Apple silicon generation and variant, parsed from `cpuModel`. */
export interface AppleChip {
  readonly generation: number
  readonly variant: 'base' | 'pro' | 'max' | 'ultra'
}

/** How a node was classified. */
export interface HardwareClassification {
  readonly hardwareClass: HardwareClassId
  /** The CPU string the class was read from, for the plan's reasons. */
  readonly cpuModel: string
  readonly apple?: AppleChip
}

const APPLE_CHIP = /^Apple M(\d+)(?:\s+(Pro|Max|Ultra))?\b/i
const INTEL_CORE_ULTRA = /Core\(TM\)\s+Ultra|Core Ultra/i
const INTEL_N_SERIES = /Intel\(R\)\s+N\d{2,3}\b|\bIntel\s+N\d{2,3}\b/i
/** Phoenix / Hawk Point mobile (7040/8040) and Ryzen 8000G desktop APUs. */
const AMD_PHOENIX = /Ryzen \d+ (7[0-9]40|8[0-9]40|8[0-9]45)[HSU]|Ryzen \d+ 8[0-9]00G/i

function parseAppleChip(cpuModel: string): AppleChip | null {
  const match = APPLE_CHIP.exec(cpuModel.trim())
  if (match === null) return null
  const generation = Number(match[1])
  const variantRaw = (match[2] ?? 'base').toLowerCase()
  const variant: AppleChip['variant'] =
    variantRaw === 'pro' || variantRaw === 'max' || variantRaw === 'ultra' ? variantRaw : 'base'
  return { generation, variant }
}

/**
 * Classify a node. Apple base chips (M1–M4) map to the measured M2 column, the
 * Pro/Max/Ultra chips to the measured M3 Pro column — the M2 was measured at
 * 1.0–1.2× the M3 Pro on the Neural Engine, so the generation inside a variant
 * matters less than the column's own error.
 */
export function classifyInferenceHardware(hw: HardwareInfo): HardwareClassification {
  const cpuModel = hw.cpuModel
  const apple = parseAppleChip(cpuModel)
  if (apple !== null) {
    return {
      hardwareClass: apple.variant === 'base' ? 'apple-m-base' : 'apple-m-pro',
      cpuModel,
      apple,
    }
  }
  if (INTEL_CORE_ULTRA.test(cpuModel)) return { hardwareClass: 'intel-core-ultra', cpuModel }
  if (INTEL_N_SERIES.test(cpuModel)) return { hardwareClass: 'intel-n-series', cpuModel }
  if (AMD_PHOENIX.test(cpuModel)) return { hardwareClass: 'amd-phoenix', cpuModel }
  return { hardwareClass: 'unknown', cpuModel }
}

/**
 * The accelerator kind of one of a node's device keys (`openvino:npu`,
 * `openvino:gpu`, `coreml:all`, `edgetpu:usb`, `cpu`, `onnx:cpu`, …). `null`
 * for a key this table has no column for.
 */
export function acceleratorKindOf(deviceKey: string, hw: HardwareInfo): AcceleratorKind | null {
  const [backend = '', device = ''] = deviceKey.split(':')
  if (backend === 'edgetpu') return 'coral'
  if (backend === 'coreml') return device === 'cpu' ? 'arm-cpu' : 'apple-ane'
  if (backend === 'openvino' && device === 'npu') return 'intel-npu'
  if (backend === 'openvino' && device === 'gpu') return 'intel-igpu'
  // AMD iGPU via ONNX WebGPU EP (P1). NPU (vitisai:npu) lands in P2.
  if (backend === 'onnx' && device === 'webgpu') return 'amd-igpu'
  if (backend === 'vitisai' && device === 'npu') return 'amd-npu'
  const isCpu = backend === 'cpu' || device === 'cpu'
  if (isCpu) return hw.arch === 'arm64' ? 'arm-cpu' : 'x86-cpu'
  return null
}
