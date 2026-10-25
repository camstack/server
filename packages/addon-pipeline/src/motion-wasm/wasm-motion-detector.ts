/**
 * WasmMotionDetector — loads the AssemblyScript WASM module and provides
 * a typed interface for motion detection.
 *
 * Pipeline: blur → diff → threshold → dilate → CCL → bounding boxes
 * All in one WASM call, ~3ms for 640×360 grayscale frames.
 *
 * The area filter that follows is NOT applied per connected component — see
 * {@link groupMotionRegions}. Fragments of one subject are merged first and the
 * bar is applied to the merged subject, relative to the motion view. D394.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  groupMotionRegions,
  DEFAULT_MERGE_RADIUS_DIVISOR,
  DEFAULT_MIN_AREA,
  DEFAULT_MIN_AREA_FRACTION,
  DEFAULT_MAX_COVERAGE_FRACTION,
  type MotionRegionGroup,
} from './region-grouping.js'

// `__dirname` is shimmed by tsup (`shims: true`) for both CJS and ESM
// output, so it works regardless of how the bundle is loaded.

export interface WasmMotionConfig {
  readonly threshold: number // pixel diff threshold 0-255
  readonly blurRadius: number // box blur radius (1 = 3×3)
  readonly dilateRadius: number // dilation radius
  /**
   * Absolute area bar in pixels, and the per-camera rollout switch. `> 0` runs
   * the pre-D394 rule in full (this bar, per component, no merging, no storm
   * cutoff) and is the default; `0` moves this camera to the measured rule.
   * Same key and same meaning as the `minArea` that shipped, so a stored value
   * keeps doing exactly what the operator who stored it asked for.
   */
  readonly minArea: number
  /** Area bar as a fraction of the motion view, used when `minArea` is 0. */
  readonly minAreaFraction: number
  /** Fragments merge when their boxes, grown to `min(w,h)/divisor`, overlap. */
  readonly mergeRadiusDivisor: number
  /** A merged group covering more of the view than this is weather, not a subject. */
  readonly maxCoverageFraction: number
}

export interface WasmMotionRegion {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly pixels: number
}

/** Raw components, the subjects they merge into, and what survived the bar. */
export interface WasmMotionResult {
  /** All regions from CCL — unmerged, unfiltered. The debug overlay's input. */
  readonly raw: ReadonlyArray<WasmMotionRegion>
  /** Merged subjects that cleared the area bar and were not suppressed. */
  readonly filtered: ReadonlyArray<MotionRegionGroup>
  /** Every merged subject, before the bar. */
  readonly groups: ReadonlyArray<MotionRegionGroup>
  /** Merged subjects the storm breaker removed on this frame. */
  readonly suppressedByCoverage: number
}

/**
 * The one place the motion defaults live. The addon's schema defaults read
 * from here — two copies of this object drifted apart once already (3000 here
 * against 1500 in the addon), and the addon's copy is the one that ran.
 */
export const DEFAULT_CONFIG: WasmMotionConfig = {
  threshold: 45,
  blurRadius: 1,
  dilateRadius: 4,
  minArea: DEFAULT_MIN_AREA,
  minAreaFraction: DEFAULT_MIN_AREA_FRACTION,
  mergeRadiusDivisor: DEFAULT_MERGE_RADIUS_DIVISOR,
  maxCoverageFraction: DEFAULT_MAX_COVERAGE_FRACTION,
}

interface WasmExports {
  memory: WebAssembly.Memory
  init(w: number, h: number): number
  getPrevOffset(): number
  getCurrOffset(): number
  getRegionOffset(): number
  detectMotion(threshold: number, blur: number, dilate: number, minArea: number): number
}

export class WasmMotionDetector {
  private wasm: WasmExports | null = null
  private prevOffset = 0
  private currOffset = 0
  private regionOffset = 0
  /** The motion view the regions are expressed in — the relative bar's denominator. */
  private width = 0
  private height = 0

  /** Load the WASM module. Call once before detect(). */
  async load(): Promise<void> {
    // Phase D bundle merge: motion.wasm ships at the bundle's
    // `wasm/motion.wasm` (one level above dist/). From this addon's
    // compiled `dist/motion-wasm/index.{js,mjs}` that's `../../wasm`.
    const wasmPath = join(__dirname, '..', '..', 'wasm', 'motion.wasm')

    const wasmBytes = readFileSync(wasmPath)
    const { instance } = await WebAssembly.instantiate(wasmBytes, {
      env: {
        abort: () => {
          throw new Error('WASM abort')
        },
      },
    })

    // Structural validation — fail fast at load() if the WASM binary
    // doesn't expose the contract we expect. Without this, contract
    // violations (renamed/removed exports, signature drift) surface only
    // at first detect() call, mid-stream, with cryptic TypeError noise.
    const exports = instance.exports
    const required: ReadonlyArray<keyof WasmExports> = [
      'memory',
      'init',
      'getPrevOffset',
      'getCurrOffset',
      'getRegionOffset',
      'detectMotion',
    ]
    for (const name of required) {
      const v = (exports as Record<string, unknown>)[name as string]
      if (v === undefined) {
        throw new Error(`motion.wasm contract violation: missing export "${String(name)}"`)
      }
      if (name === 'memory') {
        if (!(v instanceof WebAssembly.Memory)) {
          throw new Error('motion.wasm contract violation: "memory" is not a WebAssembly.Memory')
        }
      } else if (typeof v !== 'function') {
        throw new Error(`motion.wasm contract violation: "${String(name)}" is not callable`)
      }
    }
    this.wasm = exports as unknown as WasmExports // TECH-DEBT: WebAssembly.Exports vs typed motion.wasm surface
  }

  /**
   * Initialize for these frame dimensions when they are not already the ones
   * the WASM is sized for. One detector instance serves every camera on the
   * node, so two cameras with different views interleaving would otherwise
   * leave the WASM sized for whichever one called `init` last — and, since
   * D394, would divide the relative area bar by the wrong view. `init` only
   * recomputes offsets and grows memory, so a call that changes nothing is
   * skipped and a call that does is cheap.
   */
  ensureSize(w: number, h: number): void {
    if (this.width === w && this.height === h) return
    this.init(w, h)
  }

  /** Initialize for given frame dimensions. Call when resolution changes. */
  init(w: number, h: number): void {
    if (!this.wasm) throw new Error('WASM not loaded — call load() first')
    this.wasm.init(w, h)
    this.width = w
    this.height = h
    this.prevOffset = this.wasm.getPrevOffset()
    this.currOffset = this.wasm.getCurrOffset()
    this.regionOffset = this.wasm.getRegionOffset()
  }

  /**
   * Detect motion between previous and current grayscale frames.
   *
   * @param prevGray - previous frame (Uint8Array, width×height)
   * @param currGray - current frame (Uint8Array, width×height)
   * @param config - detection parameters (optional, uses defaults)
   * @returns raw CCL regions, the subjects they merge into, and the survivors
   */
  detect(
    prevGray: Uint8Array | Buffer,
    currGray: Uint8Array | Buffer,
    config: Partial<WasmMotionConfig> = {},
  ): WasmMotionResult {
    if (!this.wasm) throw new Error('WASM not loaded')

    const cfg = { ...DEFAULT_CONFIG, ...config }

    // Copy frames to WASM linear memory
    const mem = new Uint8Array(this.wasm.memory.buffer)
    mem.set(prevGray, this.prevOffset)
    mem.set(currGray, this.currOffset)

    // Run detection — WASM returns ALL regions; the area bar is applied in JS,
    // to merged subjects rather than to components.
    const numRegions = this.wasm.detectMotion(cfg.threshold, cfg.blurRadius, cfg.dilateRadius, 0)

    if (numRegions === 0) {
      return { raw: [], filtered: [], groups: [], suppressedByCoverage: 0 }
    }

    // Read all regions from WASM
    const view = new DataView(this.wasm.memory.buffer)
    const raw: WasmMotionRegion[] = []
    for (let i = 0; i < numRegions; i++) {
      const base = this.regionOffset + i * 20
      raw.push({
        x: view.getInt32(base, true),
        y: view.getInt32(base + 4, true),
        w: view.getInt32(base + 8, true),
        h: view.getInt32(base + 12, true),
        pixels: view.getInt32(base + 16, true),
      })
    }

    // Merge fragments into subjects, THEN judge each subject on its own
    // summed area — the bar relative to the motion view unless an operator
    // pinned an absolute one. D394.
    const grouped = groupMotionRegions(raw, {
      viewWidth: this.width,
      viewHeight: this.height,
      mergeRadiusDivisor: cfg.mergeRadiusDivisor,
      minAreaFraction: cfg.minAreaFraction,
      minArea: cfg.minArea,
      maxCoverageFraction: cfg.maxCoverageFraction,
    })

    return {
      raw,
      filtered: grouped.passed,
      groups: grouped.groups,
      suppressedByCoverage: grouped.suppressedByCoverage,
    }
  }
}
