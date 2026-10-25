#!/usr/bin/env -S npx tsx
/**
 * Motion-derived cropping vs the full-frame detector pass — measurement harness.
 *
 * WHAT IT MEASURES
 * ----------------
 * For each sampled instant of REAL recorded footage it runs TWO detector passes
 * over the SAME pixels, through the SAME pinned model on the SAME node, and
 * records every box each returns — including the boxes the executor discarded,
 * and why:
 *
 *   arm A "full"  — the production content view (a 320 model on a 16:9 camera
 *                   sees 320x180), i.e. exactly what the live path detects on.
 *   arm B "crops" — reference-shaped crops derived from OUR motion step, cut
 *                   from the FULL-resolution frame: each motion box padded
 *                   x1.5 about its centre, overlapping boxes unioned, top 3 by
 *                   area, grown to the detector's input aspect ratio without
 *                   ever shrinking, no minimum size (small crops are upscaled
 *                   by the pool's preprocessor).
 *
 * Motion regions come from the real `packages/addon-pipeline/wasm/motion.wasm`,
 * on the real motion view (`MOTION_FRAME_VIEW` = 320x320 contain, gray => 320x180
 * on a 16:9 camera), with the addon's shipped config, at the inter-frame lag
 * implied by `motionFps`. `MCE_MINAREA` / `MCE_THRESHOLD` override that config
 * so "what would a more sensitive motion step buy" is a re-run, not a rewrite.
 *
 * Recall is scored per FRAME against VISUALLY CONFIRMED presence intervals
 * (`scripts/motion-crop-recall/ground-truth.json`), read off contact sheets by
 * a human. False positives are measured on separate QUIET windows — footage
 * from the same camera with motion but no subject — because a recall gain paid
 * for with a false-positive storm is not a gain.
 *
 * WHAT IT MUTATES: nothing. Recordings are read through `recording.readGopBytes`
 * (a byte-range cut, no transcode), inference goes through
 * `benchmark.runPipelineTest` (a benchmark surface), and the model id is PINNED
 * and verified against what the node echoes back — a substitution throws rather
 * than letting a delta be produced by a different model.
 *
 * TWO TRAPS THIS HARNESS HAS ALREADY FALLEN INTO, both now guarded:
 *  - A shed frame comes back as `{detections: [], discarded: undefined}` with a
 *    plausible `predictMs` (`dispatchPostprocess` maps a pool shed to empty
 *    detections on purpose), so an overloaded node is indistinguishable from an
 *    empty scene. Two concurrent runs made 20 instants that HAD returned boxes
 *    come back empty. A wholly empty result is now re-asked once: a real empty
 *    scene repeats, a shed does not. NEVER run two of these concurrently.
 *  - Sampling at 2 s on ~2 s GOPs put every other instant at a GOP start, where
 *    the earlier motion frame is not in the fragment. Those frames were skipped
 *    silently, halving the sample. The pair is now taken forward when it cannot
 *    be taken backward — the diff is symmetric and the lag is identical.
 *
 * HOW TO RE-RUN
 * -------------
 *   npx tsx scripts/motion-crop-recall-eval.mts run  <windows.json> <out.jsonl>
 *   npx tsx scripts/motion-crop-recall-eval.mts sheet <deviceId> <out.jpg> <cols> <tileW> <t...>
 *   npx tsx scripts/motion-crop-recall-eval.mts fp-windows <deviceId> <sinceMs> <untilMs> <out.json>
 *   npx tsx scripts/motion-crop-recall-eval.mts report <out.jsonl> [more.jsonl ...]
 *
 * `windows.json`: `[{ id, kind: 'event'|'quiet', deviceId, fromMs, toMs, stepMs }]`.
 * Shipped inputs live in `scripts/motion-crop-recall/`; raw frames and results
 * stay under `scratchpad/` (gitignored). `sheet` builds the contact sheet used
 * to author the ground truth — presence is a human judgement, not an inference.
 *
 * Environment: `MCE_NODE` (default `agent-a`), `MCE_MODEL` (default
 * `yolov9m-320-int8`), `MCE_MINAREA`, `MCE_THRESHOLD`, `MCE_ANALYSIS_W`,
 * `MCE_HUB` and `MCE_TOKEN_FILE` (explicit overrides only: the hub comes from
 * `CAMSTACK_HUB_URL` / `scratchpad/.hub-url` / the session and the token from the
 * `camstack login` session, through scripts/hub/credentials.mjs).
 *
 * `MCE_NODE`/`MCE_MODEL` are NOT a property of the camera: the session
 * balancer places each detection session by capacity, so read
 * `inference device selection` in the hub log for the episode you are
 * measuring before pinning them. Camera 101 has run on all three nodes.
 *
 * `MCE_ANALYSIS_W` widens the `full` arm's view. The default 320 is the model
 * input, not the picture the live path hands the pool: 101's stored boxes are
 * exact multiples of 1.2 of 3840, i.e. integers on a 3200-px raster. The
 * larger the view, the more of the reduction the POOL's preprocessor does
 * rather than ffmpeg, and it is not neutral — measured on one slice, 1280
 * moves the first surviving `animal` 300 ms later than 320. Above ~1280 the
 * base64 payload exceeds `addons.custom`'s limit and every call fails.
 *
 * The measurement this produced: `docs/benchmarks/motion-crop-recall.md`.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveHubAuth, type HubAuth } from './hub/credentials.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const SCRATCH = join(REPO, 'scratchpad', 'motion-crop')
const TMP = join(SCRATCH, 'tmp')
const INPUTS = join(HERE, 'motion-crop-recall')
const WASM_PATH = join(REPO, 'packages', 'addon-pipeline', 'wasm', 'motion.wasm')

const NODE_ID = process.env['MCE_NODE'] ?? 'agent-a'
const MODEL_ID = process.env['MCE_MODEL'] ?? 'yolov9m-320-int8'

/** `MOTION_FRAME_VIEW` is `content 320x320, fit contain, gray` — 320x180 on 16:9. */
const MOTION_W = 320
const MOTION_H = 180
/**
 * The production content view a 320 model gets on a 16:9 camera.
 *
 * `MCE_ANALYSIS_W` overrides it. The live path does NOT always feed the model
 * a 320-wide picture: on 101 the stored boxes are exact multiples of 1.2 of
 * 3840, i.e. integers on a 3200-px raster, so the pool's own preprocessor is
 * what reduces 3200x1800 to the model input. Feeding the harness the same
 * 3200-px view is how "did the RESAMPLER lose the subject" is asked.
 */
const ANALYSIS_W = Number(process.env['MCE_ANALYSIS_W'] ?? 320)
const ANALYSIS_H = Math.round((ANALYSIS_W * 9) / 16)
/** `motionFps` 4 on a 25 fps stream ⇒ consecutive motion frames are 6 apart. */
const MOTION_LAG_FRAMES = 6
/** Bound the payload; above this the 320 model downsamples anyway. */
const CROP_MAX_SIDE = 1024
const PACING_MS = 200
const FRAME_BYTES = MOTION_W * MOTION_H

/** `packages/addon-pipeline/src/motion-wasm/addon/index.ts` DEFAULT_CONFIG. */
const PROD_MOTION_CONFIG: WasmMotionConfig = {
  threshold: 45,
  blurRadius: 1,
  dilateRadius: 4,
  minArea: 1500,
}

/** The reference recipe: pad the motion box x1.5 about its centre, keep 3. */
const MOTION_PAD = 1.5
const TOP_N = 3

// ── types ────────────────────────────────────────────────────────────────

export interface WasmMotionConfig {
  readonly threshold: number
  readonly blurRadius: number
  readonly dilateRadius: number
  readonly minArea: number
}

export interface MotionRegion {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly pixels: number
}

export interface Rect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface CropPlan {
  /** Every unioned region, largest first, already grown and clamped. */
  readonly all: readonly Rect[]
  /** The `TOP_N` largest — what the reference recipe would actually run. */
  readonly kept: readonly Rect[]
  /** How many regions the top-N cap threw away. */
  readonly droppedByTopN: number
}

interface EvalWindow {
  readonly id: string
  readonly kind: 'event' | 'quiet'
  readonly deviceId: number
  readonly fromMs: number
  readonly toMs: number
  readonly stepMs: number
  /**
   * Spend an inference only where the motion step fired. Camera 101 runs
   * `detectionMode: on-motion`, so this is the production shape for BOTH arms
   * and it is the only affordable way to sample a long quiet stretch at the
   * motion cadence: motion over a decoded GOP is free, inference is not.
   * A sparse sweep of quiet footage measures nothing — 123 samples at 6 s found
   * zero motion in windows where production logged 40-80 motion events per
   * 10 minutes.
   */
  readonly onlyOnMotion?: boolean
  /** Bound the detector calls a single window may spend. */
  readonly maxCalls?: number
}

interface PresenceInterval {
  readonly id: string
  readonly fromMs: number
  readonly toMs: number
  readonly subject: string
}

interface GroundTruth {
  readonly intervals: readonly PresenceInterval[]
}

interface DetectorBox {
  readonly macroClass: string
  readonly score: number
  readonly kept: boolean
  /**
   * The box in the coordinates of the pixels the pass was FED, when the node
   * returned one. Optional because a run written before this field existed has
   * none, and because the zone question it answers is not part of recall.
   */
  readonly bbox?: Rect
}

interface PassResult {
  readonly detections: readonly DetectorBox[]
  readonly discarded: readonly DiscardedBox[]
  readonly predictMs: number | undefined
  readonly preprocessMs: number | undefined
  readonly stepMs: number | undefined
  readonly wallMs: number
  readonly modelId: string | undefined
  readonly shed: string | undefined
  readonly reprobed?: true
}

interface DiscardedBox {
  readonly macroClass: string
  readonly score: number
  readonly reason: string
  /** See {@link DetectorBox.bbox}. */
  readonly bbox?: Rect
}

interface CropPass extends PassResult {
  readonly box: Rect
}

interface FrameRecord {
  readonly windowId: string
  readonly kind: 'event' | 'quiet'
  readonly deviceId: number
  readonly t: number
  skip?: string
  error?: string
  motion?: {
    readonly rawCount: number
    readonly filteredCount: number
    readonly regions: readonly MotionRegion[]
    readonly rawRegions: readonly MotionRegion[]
  }
  motionConfig?: WasmMotionConfig
  frame?: { readonly W: number; readonly H: number }
  full?: PassResult
  cropPlan?: {
    readonly total: number
    readonly kept: number
    readonly droppedByTopN: number
    readonly boxes: readonly Rect[]
  }
  crops?: CropPass[]
}

// ── crop derivation (pure) ───────────────────────────────────────────────

function padAbout(r: Rect, pad: number): Rect {
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  const w = r.w * pad
  const h = r.h * pad
  return { x: cx - w / 2, y: cy - h / 2, w, h }
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

function unionRect(a: Rect, b: Rect): Rect {
  const x1 = Math.min(a.x, b.x)
  const y1 = Math.min(a.y, b.y)
  const x2 = Math.max(a.x + a.w, b.x + b.w)
  const y2 = Math.max(a.y + a.h, b.y + b.h)
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

/** Merge every overlapping pair, repeatedly, until nothing merges. */
export function unionOverlapping(boxes: readonly Rect[]): readonly Rect[] {
  const out: Rect[] = boxes.map((b) => ({ ...b }))
  let merged = true
  while (merged) {
    merged = false
    for (let i = 0; i < out.length && !merged; i++) {
      for (let jdx = i + 1; jdx < out.length; jdx++) {
        const a = out[i]
        const b = out[jdx]
        if (a === undefined || b === undefined) continue
        if (!intersects(a, b)) continue
        out[i] = unionRect(a, b)
        out.splice(jdx, 1)
        merged = true
        break
      }
    }
  }
  return out
}

/** Grow (never shrink) to `aspect` = w/h, keeping the centre. */
export function growToAspect(b: Rect, aspect: number): Rect {
  const current = b.w / b.h
  if (Math.abs(current - aspect) < 1e-6) return { ...b }
  const cx = b.x + b.w / 2
  const cy = b.y + b.h / 2
  const w = current < aspect ? b.h * aspect : b.w
  const h = current < aspect ? b.h : b.w / aspect
  return { x: cx - w / 2, y: cy - h / 2, w, h }
}

/**
 * Shift a crop back inside the frame before clamping, so an edge subject keeps
 * its crop SIZE instead of losing half of it — that is what "never shrinking"
 * has to mean once the frame runs out.
 */
function clampInside(b: Rect, frameW: number, frameH: number): Rect {
  const w = Math.min(b.w, frameW)
  const h = Math.min(b.h, frameH)
  const x = Math.max(0, Math.min(b.x, frameW - w))
  const y = Math.max(0, Math.min(b.y, frameH - h))
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
}

/**
 * @param regions motion regions in the MOTION frame space
 * @param scale   motion-space -> full-resolution multiplier
 * @param aspect  detector input aspect ratio (1 for a square model input)
 *
 * The x1.25-around-an-intersecting-TRACKED-box term of the reference recipe is not
 * modelled: a stills harness has no live tracker, and that term can only ENLARGE
 * a crop, so its absence makes this arm conservative for recall, never
 * optimistic.
 */
export function buildCrops(
  regions: readonly MotionRegion[],
  scale: number,
  frameW: number,
  frameH: number,
  aspect = 1,
  topN = TOP_N,
  pad = MOTION_PAD,
): CropPlan {
  const scaled = regions.map((r) =>
    padAbout({ x: r.x * scale, y: r.y * scale, w: r.w * scale, h: r.h * scale }, pad),
  )
  const ranked = [...unionOverlapping(scaled)].sort((a, b) => b.w * b.h - a.w * a.h)
  const finish = (b: Rect): Rect => clampInside(growToAspect(b, aspect), frameW, frameH)
  return {
    all: ranked.map(finish),
    kept: ranked.slice(0, topN).map(finish),
    droppedByTopN: Math.max(0, ranked.length - topN),
  }
}

// ── motion.wasm ──────────────────────────────────────────────────────────

interface MotionExports {
  readonly memory: WebAssembly.Memory
  init(w: number, h: number): number
  getPrevOffset(): number
  getCurrOffset(): number
  getRegionOffset(): number
  detectMotion(threshold: number, blur: number, dilate: number, minArea: number): number
}

function isMotionExports(value: WebAssembly.Exports): value is WebAssembly.Exports & MotionExports {
  const required = ['init', 'getPrevOffset', 'getCurrOffset', 'getRegionOffset', 'detectMotion']
  return (
    value['memory'] instanceof WebAssembly.Memory &&
    required.every((name) => typeof value[name] === 'function')
  )
}

/**
 * Standalone loader for the addon's own `motion.wasm`. It mirrors
 * `WasmMotionDetector.detect()` exactly — same offsets, same 20-byte region
 * stride, and the same JS-side `minArea` filter (the WASM call always passes 0,
 * so `raw` is the unfiltered CCL census and `minArea` can be re-thresholded
 * offline). The class itself is not importable here: it resolves the asset
 * relative to its COMPILED `dist/` location.
 */
export class MotionWasm {
  private constructor(
    private readonly wasm: MotionExports,
    private prevOffset = 0,
    private currOffset = 0,
    private regionOffset = 0,
  ) {}

  static async load(): Promise<MotionWasm> {
    const { instance } = await WebAssembly.instantiate(readFileSync(WASM_PATH), {
      env: {
        abort: (): never => {
          throw new Error('WASM abort')
        },
      },
    })
    if (!isMotionExports(instance.exports)) {
      throw new Error('motion.wasm contract violation: missing or non-callable export')
    }
    return new MotionWasm(instance.exports)
  }

  init(w: number, h: number): void {
    this.wasm.init(w, h)
    this.prevOffset = this.wasm.getPrevOffset()
    this.currOffset = this.wasm.getCurrOffset()
    this.regionOffset = this.wasm.getRegionOffset()
  }

  detect(
    prevGray: Uint8Array,
    currGray: Uint8Array,
    config: WasmMotionConfig,
  ): { readonly raw: readonly MotionRegion[]; readonly filtered: readonly MotionRegion[] } {
    const mem = new Uint8Array(this.wasm.memory.buffer)
    mem.set(prevGray, this.prevOffset)
    mem.set(currGray, this.currOffset)
    const count = this.wasm.detectMotion(
      config.threshold,
      config.blurRadius,
      config.dilateRadius,
      0,
    )
    if (count === 0) return { raw: [], filtered: [] }
    const view = new DataView(this.wasm.memory.buffer)
    const raw: MotionRegion[] = []
    for (let i = 0; i < count; i++) {
      const base = this.regionOffset + i * 20
      raw.push({
        x: view.getInt32(base, true),
        y: view.getInt32(base + 4, true),
        w: view.getInt32(base + 8, true),
        h: view.getInt32(base + 12, true),
        pixels: view.getInt32(base + 16, true),
      })
    }
    return { raw, filtered: raw.filter((r) => r.pixels >= config.minArea) }
  }
}

// ── hub access ───────────────────────────────────────────────────────────

let hubAuth: HubAuth | null = null

/** The session through the shared resolver; called once, at the start of `main`. */
async function connectHub(): Promise<void> {
  const server = process.env['MCE_HUB']
  const tokenFile = process.env['MCE_TOKEN_FILE']
  hubAuth = await resolveHubAuth({
    ...(server ? { server } : {}),
    ...(tokenFile ? { tokenFile } : {}),
  })
}

function connected(): HubAuth {
  if (hubAuth === null) throw new Error('connectHub() was not called')
  return hubAuth
}

function bearer(): string {
  return connected().token
}

interface TrpcEnvelope {
  readonly result?: { readonly data?: { readonly json?: unknown } }
  readonly error?: unknown
}

function unwrap(body: TrpcEnvelope, path: string): unknown {
  if (body.error !== undefined) {
    throw new Error(`${path}: ${JSON.stringify(body.error).slice(0, 400)}`)
  }
  return body.result?.data?.json
}

async function hubPost(path: string, input: unknown): Promise<unknown> {
  const res = await fetch(`${connected().server}/trpc/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer()}` },
    body: JSON.stringify({ json: input }),
  })
  const body: unknown = await res.json()
  return unwrap(body as TrpcEnvelope, path)
}

function hubGetSync(path: string, input: unknown): unknown {
  const url = `${connected().server}/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`
  const out = execFileSync(
    process.execPath,
    [
      '-e',
      `fetch(process.argv[1],{headers:{authorization:'Bearer '+process.argv[2]}}).then(r=>r.text()).then(t=>process.stdout.write(t))`,
      url,
      bearer(),
    ],
    { maxBuffer: 1 << 29, env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' } },
  )
  const parsed: unknown = JSON.parse(out.toString())
  return unwrap(parsed as TrpcEnvelope, path)
}

// ── recorded pixels ──────────────────────────────────────────────────────

interface LocatedSegment {
  readonly kind: string
  readonly startMs?: number
}

interface GopBytes {
  readonly data: readonly number[]
  readonly gopStartMs: number
  readonly gopDurMs: number
}

interface DecodedGop {
  readonly mp4: string
  readonly base: number
  readonly durMs: number
  readonly gray: Buffer
  readonly frames: number
}

function ffmpeg(args: readonly string[]): void {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { maxBuffer: 1 << 28 })
}

function probeSize(path: string): { readonly w: number; readonly h: number } {
  const out = execFileSync('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v',
    '-show_entries',
    'stream=width,height',
    '-of',
    'csv=p=0',
    path,
  ])
    .toString()
    .trim()
    .split(',')
  return { w: Number(out[0]), h: Number(out[1]) }
}

let gopCache: DecodedGop | null = null

/** Fetch and fully decode the GOP covering `t` into a gray motion-view strip. */
function gopFor(deviceId: number, t: number): DecodedGop | null {
  const cached = gopCache
  if (cached !== null && t >= cached.base && t < cached.base + cached.durMs) return cached
  const seg = hubGetSync('recording.locateSegment', { deviceId, profile: 'high', epochMs: t })
  const located = seg as LocatedSegment
  if (located.kind !== 'segment' || located.startMs === undefined) return null
  const gop = hubGetSync('recording.readGopBytes', {
    deviceId,
    profile: 'high',
    startMs: located.startMs,
    epochMs: t,
  }) as GopBytes
  mkdirSync(TMP, { recursive: true })
  const mp4 = join(TMP, 'gop.mp4')
  writeFileSync(mp4, Buffer.from(gop.data))
  const raw = join(TMP, 'gop-gray.raw')
  ffmpeg(['-i', mp4, '-vf', `scale=${MOTION_W}:${MOTION_H},format=gray`, '-f', 'rawvideo', raw])
  const gray = readFileSync(raw)
  gopCache = {
    mp4,
    base: gop.gopStartMs,
    durMs: gop.gopDurMs,
    gray,
    frames: Math.floor(gray.length / FRAME_BYTES),
  }
  return gopCache
}

function jpegAt(mp4: string, offsetSec: number, dst: string, filter?: string): Buffer | null {
  const args = ['-ss', String(Math.max(0, offsetSec)), '-i', mp4, '-frames:v', '1']
  if (filter !== undefined) args.push('-vf', filter)
  args.push('-q:v', '2', dst)
  ffmpeg(args)
  return existsSync(dst) ? readFileSync(dst) : null
}

// ── the detector call ────────────────────────────────────────────────────

interface RunPipelineDetection {
  readonly macroClass: string
  readonly score: number
  /** `DetectionBoundingBox` — absolute pixels of the frame the pass was fed. */
  readonly bbox?: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
}

interface RunPipelineDiscarded {
  readonly macroClass: string
  readonly score: number
  readonly reason: string
  /** `DiscardedDetection.bbox` — `[x1, y1, x2, y2]`, absolute analysis pixels. */
  readonly bbox?: readonly [number, number, number, number]
}

interface RunPipelineResult {
  readonly detections?: readonly RunPipelineDetection[]
  readonly discarded?: readonly RunPipelineDiscarded[]
  readonly shed?: boolean
  readonly shedReason?: string
  readonly debug?: {
    readonly predictMs?: number
    readonly preprocessMs?: number
    readonly stepTimings?: readonly { readonly modelId?: string; readonly ms?: number }[]
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function runDetectorOnce(jpeg: Buffer, label: string): Promise<PassResult> {
  const started = Date.now()
  const raw = await hubPost('addons.custom', {
    addonId: 'benchmark',
    action: 'runPipelineTest',
    input: {
      steps: [{ addonId: 'object-detection', enabled: true, modelId: MODEL_ID }],
      imageBase64: jpeg.toString('base64'),
      nodeId: NODE_ID,
      sessionId: `mce-${label}-${Date.now()}`,
      plane: 'frame',
    },
  })
  const result = raw as RunPipelineResult
  const ranModel = result.debug?.stepTimings?.[0]?.modelId
  if (ranModel !== undefined && ranModel !== MODEL_ID) {
    throw new Error(`model substituted: asked ${MODEL_ID}, ran ${ranModel}`)
  }
  return {
    detections: (result.detections ?? []).map((d) => ({
      macroClass: d.macroClass,
      score: d.score,
      kept: true,
      ...(d.bbox === undefined
        ? {}
        : { bbox: { x: d.bbox.x, y: d.bbox.y, w: d.bbox.width, h: d.bbox.height } }),
    })),
    discarded: (result.discarded ?? []).map((d) => ({
      macroClass: d.macroClass,
      score: d.score,
      reason: d.reason,
      ...(d.bbox === undefined
        ? {}
        : {
            bbox: {
              x: d.bbox[0],
              y: d.bbox[1],
              w: d.bbox[2] - d.bbox[0],
              h: d.bbox[3] - d.bbox[1],
            },
          }),
    })),
    predictMs: result.debug?.predictMs,
    preprocessMs: result.debug?.preprocessMs,
    stepMs: result.debug?.stepTimings?.[0]?.ms,
    wallMs: Date.now() - started,
    modelId: ranModel,
    shed: result.shed === true ? (result.shedReason ?? 'shed') : undefined,
  }
}

/** See the shed trap in the file docblock: a wholly empty result is re-asked. */
async function runDetector(jpeg: Buffer, label: string): Promise<PassResult> {
  const first = await runDetectorOnce(jpeg, label)
  if (first.detections.length > 0 || first.discarded.length > 0) return first
  await sleep(400)
  const second = await runDetectorOnce(jpeg, `${label}-reprobe`)
  return { ...second, reprobed: true }
}

// ── the run ──────────────────────────────────────────────────────────────

function motionConfig(): WasmMotionConfig {
  const minArea = process.env['MCE_MINAREA']
  const threshold = process.env['MCE_THRESHOLD']
  return {
    ...PROD_MOTION_CONFIG,
    ...(minArea !== undefined ? { minArea: Number(minArea) } : {}),
    ...(threshold !== undefined ? { threshold: Number(threshold) } : {}),
  }
}

async function runWindows(windowsPath: string, outPath: string): Promise<void> {
  const windows: readonly EvalWindow[] = JSON.parse(readFileSync(windowsPath, 'utf8'))
  const motion = await MotionWasm.load()
  motion.init(MOTION_W, MOTION_H)
  const config = motionConfig()
  mkdirSync(TMP, { recursive: true })

  for (const win of windows) {
    let calls = 0
    for (let t = win.fromMs; t <= win.toMs; t += win.stepMs) {
      if (win.maxCalls !== undefined && calls >= win.maxCalls) break
      const rec: FrameRecord = { windowId: win.id, kind: win.kind, deviceId: win.deviceId, t }
      try {
        const gop = gopFor(win.deviceId, t)
        if (gop === null) {
          rec.skip = 'no-segment'
          appendFileSync(outPath, `${JSON.stringify(rec)}\n`)
          continue
        }
        const offsetSec = (t - gop.base) / 1000
        const idx = Math.min(
          gop.frames - 1,
          Math.max(0, Math.round((offsetSec / (gop.durMs / 1000)) * gop.frames)),
        )
        const pairIdx =
          idx - MOTION_LAG_FRAMES >= 0 ? idx - MOTION_LAG_FRAMES : idx + MOTION_LAG_FRAMES
        if (pairIdx < 0 || pairIdx >= gop.frames) {
          rec.skip = 'gop-edge'
          appendFileSync(outPath, `${JSON.stringify(rec)}\n`)
          continue
        }
        const pair = gop.gray.subarray(pairIdx * FRAME_BYTES, (pairIdx + 1) * FRAME_BYTES)
        const current = gop.gray.subarray(idx * FRAME_BYTES, (idx + 1) * FRAME_BYTES)
        const detected = motion.detect(pair, current, config)
        rec.motion = {
          rawCount: detected.raw.length,
          filteredCount: detected.filtered.length,
          regions: detected.filtered,
          rawRegions: detected.raw,
        }
        rec.motionConfig = config
        if (win.onlyOnMotion === true && detected.filtered.length === 0) {
          appendFileSync(outPath, `${JSON.stringify(rec)}\n`)
          continue
        }
        calls += 1

        const fullPath = join(TMP, 'full.jpg')
        const viewPath = join(TMP, 'view.jpg')
        jpegAt(gop.mp4, offsetSec, fullPath)
        const view = jpegAt(gop.mp4, offsetSec, viewPath, `scale=${ANALYSIS_W}:${ANALYSIS_H}`)
        if (view === null) {
          rec.skip = 'view-decode'
          appendFileSync(outPath, `${JSON.stringify(rec)}\n`)
          continue
        }
        const size = probeSize(fullPath)
        rec.frame = { W: size.w, H: size.h }
        rec.full = await runDetector(view, 'full')
        await sleep(PACING_MS)

        const plan = buildCrops(detected.filtered, size.w / MOTION_W, size.w, size.h, 1)
        rec.cropPlan = {
          total: plan.all.length,
          kept: plan.kept.length,
          droppedByTopN: plan.droppedByTopN,
          boxes: plan.kept,
        }
        rec.crops = []
        for (const [i, box] of plan.kept.entries()) {
          if (box.w < 8 || box.h < 8) continue
          const cropPath = join(TMP, `crop${i}.jpg`)
          const longSide = Math.max(box.w, box.h)
          const downscale = longSide > CROP_MAX_SIDE ? `,scale=${CROP_MAX_SIDE}:-2` : ''
          const buf = jpegAt(
            gop.mp4,
            offsetSec,
            cropPath,
            `crop=${box.w}:${box.h}:${box.x}:${box.y}${downscale}`,
          )
          if (buf === null) continue
          rec.crops.push({ box, ...(await runDetector(buf, `crop${i}`)) })
          await sleep(PACING_MS)
        }
      } catch (err) {
        rec.error = String(err).slice(0, 300)
      }
      appendFileSync(outPath, `${JSON.stringify(rec)}\n`)
      process.stdout.write(
        `${win.id} ${new Date(t).toISOString().slice(11, 19)} ` +
          `motion=${rec.motion?.filteredCount ?? '-'}/${rec.motion?.rawCount ?? '-'} ` +
          `crops=${rec.crops?.length ?? '-'} full=${rec.full?.detections.length ?? '-'} ${rec.error ?? ''}\n`,
      )
    }
  }
}

// ── contact sheet (ground truth is a human judgement) ────────────────────

function buildSheet(
  deviceId: number,
  out: string,
  cols: number,
  tileW: number,
  times: readonly number[],
): void {
  const dir = join(SCRATCH, 'sheet')
  mkdirSync(dir, { recursive: true })
  const tiles: string[] = []
  for (const [k, t] of times.entries()) {
    const gop = gopFor(deviceId, t)
    if (gop === null) continue
    const tile = join(dir, `t${String(k).padStart(2, '0')}.jpg`)
    ffmpeg([
      '-ss',
      String(Math.max(0, (t - gop.base) / 1000)),
      '-i',
      gop.mp4,
      '-frames:v',
      '1',
      '-vf',
      `scale=${tileW}:-2`,
      '-q:v',
      '4',
      tile,
    ])
    tiles.push(tile)
  }
  const layout = tiles
    .map((_, i) => {
      const col = i % cols
      const row = Math.floor(i / cols)
      const x = col === 0 ? '0' : Array.from({ length: col }, (_, q) => `w${q}`).join('+')
      const y = row === 0 ? '0' : Array.from({ length: row }, (_, q) => `h${q * cols}`).join('+')
      return `${x}_${y}`
    })
    .join('|')
  const args: string[] = []
  for (const tile of tiles) args.push('-i', tile)
  args.push(
    '-filter_complex',
    `${tiles.map((_, i) => `[${i}:v]`).join('')}xstack=inputs=${tiles.length}:layout=${layout}:fill=black`,
    '-q:v',
    '4',
    out,
  )
  ffmpeg(args)
  process.stdout.write(`${out} — ${tiles.length} tiles\n`)
  process.stdout.write(
    `${times.map((t, i) => `${i + 1}:${new Date(t).toISOString().slice(11, 19)}`).join(' ')}\n`,
  )
}

// ── false-positive corpus ────────────────────────────────────────────────

interface StoredEvent {
  readonly timestamp: number
}

/**
 * Build the FP corpus from REAL motion edges that produced no object event:
 * "motion fired and nothing was there" is the case a crop feature is supposed
 * to be dangerous in. Picking arbitrary "quiet" stretches instead measures
 * nothing — 123 samples at 6 s over three such stretches found zero motion in
 * windows where production had logged 40-80 motion events per 10 minutes.
 */
function buildFalsePositiveWindows(
  deviceId: number,
  since: number,
  until: number,
  out: string,
): void {
  const motion = hubGetSync('pipelineAnalytics.getMotionEvents', {
    deviceId,
    since,
    until,
    limit: 5000,
    projection: 'slim',
  }) as readonly StoredEvent[]
  const objects = hubGetSync('pipelineAnalytics.getObjectEvents', {
    deviceId,
    since,
    until,
    limit: 5000,
    projection: 'slim',
  }) as readonly StoredEvent[]
  const objectTimes = objects.map((o) => o.timestamp)
  const candidates = motion
    .map((m) => m.timestamp)
    .filter((t) => !objectTimes.some((o) => Math.abs(o - t) < 60_000))
    .sort((a, b) => a - b)
  const picked: number[] = []
  for (const t of candidates) {
    const last = picked[picked.length - 1]
    if (last !== undefined && t - last < 8_000) continue
    picked.push(t)
  }
  const windows: readonly EvalWindow[] = picked.slice(0, 60).map((t, i) => ({
    id: `FP${String(i).padStart(2, '0')}`,
    kind: 'quiet',
    deviceId,
    fromMs: t - 2_000,
    toMs: t + 4_000,
    stepMs: 250,
    onlyOnMotion: true,
    maxCalls: 8,
  }))
  writeFileSync(out, `${JSON.stringify(windows, null, 2)}\n`)
  process.stdout.write(
    `motion=${motion.length} objects=${objects.length} object-free=${candidates.length} windows=${windows.length}\n`,
  )
}

// ── report ───────────────────────────────────────────────────────────────

function classBoxes(pass: PassResult | undefined, macro: string): readonly DetectorBox[] {
  if (pass === undefined) return []
  // `kept` is derived from WHICH array the box came out of, never read back
  // from the record: a run written before the field existed would otherwise
  // report every surviving box as discarded, silently and plausibly.
  return [
    ...pass.detections
      .filter((d) => d.macroClass === macro)
      .map((d) => ({ macroClass: d.macroClass, score: d.score, kept: true })),
    ...pass.discarded
      .filter((d) => d.macroClass === macro)
      .map((d) => ({ macroClass: d.macroClass, score: d.score, kept: false })),
  ]
}

const bestScore = (boxes: readonly DetectorBox[]): number | null =>
  boxes.length === 0 ? null : Math.max(...boxes.map((b) => b.score))

const pct = (n: number, d: number): string =>
  d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(0)}% (${n}/${d})`

function quantiles(values: readonly number[]): string {
  if (values.length === 0) return 'none'
  const s = [...values].sort((a, b) => a - b)
  const q = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0
  return `n=${s.length} min=${(s[0] ?? 0).toFixed(3)} p25=${q(0.25).toFixed(3)} med=${q(0.5).toFixed(3)} p75=${q(0.75).toFixed(3)} max=${(s[s.length - 1] ?? 0).toFixed(3)}`
}

function latency(values: readonly (number | undefined)[]): string {
  const s = values.filter((v): v is number => typeof v === 'number').sort((a, b) => a - b)
  if (s.length === 0) return 'none'
  return `n=${s.length} p50=${(s[Math.floor(s.length * 0.5)] ?? 0).toFixed(1)}ms p95=${(s[Math.floor(s.length * 0.95)] ?? 0).toFixed(1)}ms max=${(s[s.length - 1] ?? 0).toFixed(1)}ms`
}

function report(paths: readonly string[]): void {
  const gt: GroundTruth = JSON.parse(readFileSync(join(INPUTS, 'ground-truth.json'), 'utf8'))
  // De-duplicate by (window, instant): a 2 s sweep and a 1 s sweep inside the
  // presence intervals overlap, and counting a frame twice inflates a rate.
  const byKey = new Map<string, FrameRecord>()
  for (const p of paths) {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      const rec: FrameRecord = JSON.parse(line)
      byKey.set(`${rec.windowId}@${rec.t}`, rec)
    }
  }
  const rows = [...byKey.values()]
  const isPositive = (r: FrameRecord): boolean =>
    gt.intervals.some((i) => i.id === r.windowId && r.t >= i.fromMs && r.t <= i.toMs)
  const cropBoxes = (r: FrameRecord, macro: string): readonly DetectorBox[] =>
    (r.crops ?? []).flatMap((c) => classBoxes(c, macro))

  const positives = rows.filter((r) => isPositive(r) && r.full !== undefined)
  const out: string[] = []
  out.push(`## Positive frames (${positives.length}), animal visually confirmed present\n`)
  out.push('| window | t (UTC) | motion filt/raw | crops | FULL best animal | CROP best animal |')
  out.push('|---|---|---|---|---|---|')
  for (const r of [...positives].sort(
    (a, b) => a.windowId.localeCompare(b.windowId) || a.t - b.t,
  )) {
    const fa = classBoxes(r.full, 'animal')
    const ca = cropBoxes(r, 'animal')
    const cell = (b: readonly DetectorBox[]): string => {
      const best = bestScore(b)
      if (best === null) return '—'
      return `${best.toFixed(4)}${b.some((x) => x.kept) ? '' : ' (discarded)'}`
    }
    out.push(
      `| ${r.windowId} | ${new Date(r.t).toISOString().slice(11, 19)} | ${r.motion?.filteredCount}/${r.motion?.rawCount} | ${r.crops?.length ?? 0} | ${cell(fa)} | ${cell(ca)} |`,
    )
  }

  const atLeast = (set: readonly FrameRecord[], arm: 'full' | 'crop', min: number): string =>
    pct(
      set.filter((r) => {
        const b = arm === 'full' ? classBoxes(r.full, 'animal') : cropBoxes(r, 'animal')
        const best = bestScore(b)
        return best !== null && best >= min
      }).length,
      set.length,
    )
  const anyBox = (set: readonly FrameRecord[], arm: 'full' | 'crop'): string =>
    pct(
      set.filter(
        (r) => (arm === 'full' ? classBoxes(r.full, 'animal') : cropBoxes(r, 'animal')).length > 0,
      ).length,
      set.length,
    )
  const survives = (set: readonly FrameRecord[], arm: 'full' | 'crop'): string =>
    pct(
      set.filter((r) =>
        (arm === 'full' ? classBoxes(r.full, 'animal') : cropBoxes(r, 'animal')).some(
          (b) => b.kept,
        ),
      ).length,
      set.length,
    )

  out.push(`\n## Aggregate over ${positives.length} positive frames\n`)
  out.push('| metric | full-frame (today) | motion crops |')
  out.push('|---|---|---|')
  out.push(
    `| an animal box exists at any score | ${anyBox(positives, 'full')} | ${anyBox(positives, 'crop')} |`,
  )
  out.push(
    `| survives the production filter chain | ${survives(positives, 'full')} | ${survives(positives, 'crop')} |`,
  )
  out.push(
    `| best animal score >= 0.50 (our floor) | ${atLeast(positives, 'full', 0.5)} | ${atLeast(positives, 'crop', 0.5)} |`,
  )
  out.push(
    `| best animal score >= 0.70 (the reference gate) | ${atLeast(positives, 'full', 0.7)} | ${atLeast(positives, 'crop', 0.7)} |`,
  )

  // Per-EPISODE: an operator is notified once per pass-by, so "did any frame of
  // this episode clear the gate" is the number a notification rule feels.
  const episodes = [...new Set(positives.map((r) => r.windowId))].sort()
  const episodeHit = (id: string, arm: 'full' | 'crop', min: number): boolean =>
    positives.some((r) => {
      if (r.windowId !== id) return false
      const b = (arm === 'full' ? classBoxes(r.full, 'animal') : cropBoxes(r, 'animal')).filter(
        (x) => x.kept,
      )
      const best = bestScore(b)
      return best !== null && best >= min
    })
  out.push('\n### Per episode — would anything have been reported at all\n')
  out.push('| episode | full >=0.50 | crops >=0.50 | full >=0.70 | crops >=0.70 |')
  out.push('|---|---|---|---|---|')
  for (const id of episodes) {
    const cell = (arm: 'full' | 'crop', min: number): string =>
      episodeHit(id, arm, min) ? 'yes' : 'NO'
    out.push(
      `| ${id} | ${cell('full', 0.5)} | ${cell('crop', 0.5)} | ${cell('full', 0.7)} | ${cell('crop', 0.7)} |`,
    )
  }
  const tally = (arm: 'full' | 'crop', min: number): string =>
    `${episodes.filter((id) => episodeHit(id, arm, min)).length}/${episodes.length}`
  out.push(
    `| **total** | ${tally('full', 0.5)} | ${tally('crop', 0.5)} | ${tally('full', 0.7)} | ${tally('crop', 0.7)} |`,
  )

  const fired = positives.filter((r) => (r.motion?.filteredCount ?? 0) > 0)
  const silent = positives.filter((r) => (r.motion?.filteredCount ?? 0) === 0)
  out.push('\n### Split by whether OUR motion step produced a region\n')
  out.push('| subset | frames | full >=0.50 | crops >=0.50 | full >=0.70 | crops >=0.70 |')
  out.push('|---|---|---|---|---|---|')
  out.push(
    `| motion fired | ${fired.length} | ${atLeast(fired, 'full', 0.5)} | ${atLeast(fired, 'crop', 0.5)} | ${atLeast(fired, 'full', 0.7)} | ${atLeast(fired, 'crop', 0.7)} |`,
  )
  out.push(
    `| motion silent | ${silent.length} | ${atLeast(silent, 'full', 0.5)} | ${atLeast(silent, 'crop', 0.5)} | ${atLeast(silent, 'full', 0.7)} | ${atLeast(silent, 'crop', 0.7)} |`,
  )
  out.push(
    `\nRaw (pre-minArea) CCL regions existed on ${positives.filter((r) => (r.motion?.rawCount ?? 0) > 0).length}/${positives.length} positive frames; regions surviving minArea on ${fired.length}/${positives.length}.`,
  )

  out.push('\n### Score distribution of every animal box on positive frames\n')
  out.push(
    `- full frame: ${quantiles(positives.flatMap((r) => classBoxes(r.full, 'animal').map((b) => b.score)))}`,
  )
  out.push(
    `- crops:      ${quantiles(positives.flatMap((r) => cropBoxes(r, 'animal').map((b) => b.score)))}`,
  )

  const measured = rows.filter((r) => r.full !== undefined)
  const cropCounts = measured.map((r) => r.crops?.length ?? 0)
  const histogram = new Map<number, number>()
  for (const c of cropCounts) histogram.set(c, (histogram.get(c) ?? 0) + 1)
  out.push('\n## Cost\n')
  out.push(`- frames measured: ${measured.length}`)
  out.push(
    `- crops per frame: ${[...histogram.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([k, v]) => `${k}→${v}`)
      .join('  ')}`,
  )
  out.push(
    `- extra detector invocations per frame: mean ${(cropCounts.reduce((a, b) => a + b, 0) / Math.max(1, measured.length)).toFixed(2)}`,
  )
  out.push(
    `- top-${TOP_N} cap dropped a region on ${measured.filter((r) => (r.cropPlan?.droppedByTopN ?? 0) > 0).length} frames`,
  )
  out.push(`- step latency, full-frame pass: ${latency(measured.map((r) => r.full?.stepMs))}`)
  out.push(
    `- step latency, crop pass:       ${latency(measured.flatMap((r) => (r.crops ?? []).map((c) => c.stepMs)))}`,
  )
  out.push(`- predict only, full-frame pass: ${latency(measured.map((r) => r.full?.predictMs))}`)
  out.push(
    `- predict only, crop pass:       ${latency(measured.flatMap((r) => (r.crops ?? []).map((c) => c.predictMs)))}`,
  )

  const quiet = rows.filter((r) => r.kind === 'quiet' && r.full !== undefined)
  if (quiet.length > 0) {
    out.push(
      `\n## False positives on quiet footage (${quiet.length} frames, ${new Set(quiet.map((r) => r.windowId)).size} windows)\n`,
    )
    const scanned = rows.filter((r) => r.kind === 'quiet' && r.motion !== undefined)
    out.push(`- frames scanned for motion: ${scanned.length}`)
    out.push(
      `- frames with >=1 motion region: ${scanned.filter((r) => (r.motion?.filteredCount ?? 0) > 0).length}`,
    )
    out.push(`- crop invocations: ${quiet.reduce((n, r) => n + (r.crops?.length ?? 0), 0)}`)
    out.push('\n| class @ gate | full-frame boxes | frames | crop boxes | frames |')
    out.push('|---|---|---|---|---|')
    const gates: readonly (readonly [string, number])[] = [
      ['animal', 0.5],
      ['animal', 0.7],
      ['person', 0.65],
      ['person', 0.8],
      ['vehicle', 0.5],
    ]
    for (const [macro, gate] of gates) {
      const fullBoxes = quiet
        .flatMap((r) => classBoxes(r.full, macro))
        .filter((b) => b.kept && b.score >= gate)
      const cropB = quiet
        .flatMap((r) => cropBoxes(r, macro))
        .filter((b) => b.kept && b.score >= gate)
      const fullFrames = quiet.filter((r) =>
        classBoxes(r.full, macro).some((b) => b.kept && b.score >= gate),
      ).length
      const cropFrames = quiet.filter((r) =>
        cropBoxes(r, macro).some((b) => b.kept && b.score >= gate),
      ).length
      out.push(
        `| ${macro} >= ${gate} | ${fullBoxes.length} | ${fullFrames} | ${cropB.length} | ${cropFrames} |`,
      )
    }
  }
  process.stdout.write(`${out.join('\n')}\n`)
}

// ── cli ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'
  const [command, ...rest] = process.argv.slice(2)
  // `report` reads local files only; the rest talk to the hub.
  if (command === 'run' || command === 'sheet' || command === 'fp-windows') await connectHub()
  if (command === 'run') {
    const [windowsPath, outPath] = rest
    if (windowsPath === undefined || outPath === undefined)
      throw new Error('run <windows.json> <out.jsonl>')
    await runWindows(windowsPath, outPath)
    return
  }
  if (command === 'sheet') {
    const [deviceId, out, cols, tileW, ...times] = rest
    if (deviceId === undefined || out === undefined || cols === undefined || tileW === undefined) {
      throw new Error('sheet <deviceId> <out.jpg> <cols> <tileW> <t...>')
    }
    buildSheet(Number(deviceId), out, Number(cols), Number(tileW), times.map(Number))
    return
  }
  if (command === 'fp-windows') {
    const [deviceId, since, until, out] = rest
    if (deviceId === undefined || since === undefined || until === undefined || out === undefined) {
      throw new Error('fp-windows <deviceId> <sinceMs> <untilMs> <out.json>')
    }
    buildFalsePositiveWindows(Number(deviceId), Number(since), Number(until), out)
    return
  }
  if (command === 'report') {
    if (rest.length === 0) throw new Error('report <out.jsonl> [more.jsonl ...]')
    report(rest)
    return
  }
  throw new Error('usage: run | sheet | fp-windows | report')
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) {
  main().catch((err: unknown) => {
    process.stderr.write(`${String(err)}\n`)
    process.exitCode = 1
  })
}
