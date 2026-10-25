import type { NpuInfo } from '@camstack/types'

/**
 * Filesystem seam for Intel NPU detection — mirrors the `AcceleratorFs` /
 * `CoralFs` pattern so the classifier stays a pure, unit-testable function over
 * injected reads.
 */
export interface NpuFs {
  /**
   * Directory entries under a path (e.g. the accel char devices under
   * `/dev/accel`). MUST return an empty list when the directory is absent.
   */
  listDir(path: string): readonly string[]
  /** Whether a filesystem path exists. */
  exists(path: string): boolean
}

/** Everything the NPU classifier needs to know about the host, beside the FS. */
export interface IntelNpuContext {
  readonly platform: 'darwin' | 'linux' | 'win32'
  readonly arch: 'arm64' | 'x64'
  /**
   * True when an Intel CPU or Intel iGPU is present. The NPU ("AI Boost") is an
   * Intel-only accelerator, so a stray `/dev/accel` node on a non-Intel host
   * (e.g. some other DRM accel driver) must NOT be misread as an Intel NPU.
   */
  readonly intelPresent: boolean
}

const ACCEL_DIR = '/dev/accel'

/** DRM accel char devices are named `accel0`, `accel1`, … */
function hasAccelNode(fsx: NpuFs): boolean {
  // Primary: list the directory and match ANY `accel*` node — tolerant of the
  // exact ordinal (the container passes `--device /dev/accel`; the node may be
  // `accel0` on a single-NPU host but the ordinal is not guaranteed).
  if (fsx.listDir(ACCEL_DIR).some((n) => n.startsWith('accel'))) return true
  // Fallback: a direct existence probe of the canonical node, for FS seams that
  // cannot enumerate a `/dev` directory but can stat a known path.
  return fsx.exists(`${ACCEL_DIR}/accel0`)
}

/**
 * Detect the Intel NPU ("AI Boost", the `intel_vpu` kernel driver).
 *
 * On Linux the NPU surfaces as a DRM accel char device `/dev/accel/accel*`.
 * Detection is gated on linux + x64 + an Intel CPU/iGPU being present — the NPU
 * only ships on x86_64 Intel Core Ultra (Meteor/Arrow Lake+) parts, so those
 * three conditions together make a matching accel node an Intel NPU.
 *
 * Returns `null` when any gate fails or no accel node is found. The caller must
 * NOT clobber an already-resolved NPU (e.g. `apple-ane` on macOS).
 */
export function classifyIntelNpu(ctx: IntelNpuContext, fsx: NpuFs): NpuInfo | null {
  if (ctx.platform !== 'linux' || ctx.arch !== 'x64' || !ctx.intelPresent) return null
  return hasAccelNode(fsx) ? { type: 'intel-npu', name: 'Intel AI Boost NPU' } : null
}
