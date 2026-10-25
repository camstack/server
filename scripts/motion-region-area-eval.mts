#!/usr/bin/env -S npx tsx
/**
 * Motion region area — the distribution behind the motion step's area bar.
 *
 * WHAT IT MEASURES
 * ----------------
 * `docs/benchmarks/motion-crop-recall.md` established that the motion step's
 * `minArea` filter, not the crop recipe, is what loses small subjects: raw
 * connected components existed on 35 of 38 frames with a visible animal, only
 * 19 survived `minArea 1500`, and the discarded regions measured 555–1495 px.
 * That report deliberately refused to name a replacement value: "decide
 * `minArea` from a measured distribution, per camera, not by copying 500 out of
 * this page."
 *
 * This harness produces that distribution. For a camera and a time window it
 * replays REAL recorded footage through the REAL
 * `packages/addon-pipeline/wasm/motion.wasm`, on the REAL motion view
 * (`MOTION_FRAME_VIEW` = content 320x320, fit contain, gray) at the REAL motion
 * cadence (`motionFps`), and records, per frame, every connected component
 * before any area filter. `report` then answers three questions off that one
 * corpus:
 *
 *   1. how large are the merged regions on frames where a subject is present,
 *      versus frames where nothing is;
 *   2. what each candidate bar costs in recall and buys in silence;
 *   3. what each candidate bar does to the MOTION DUTY CYCLE — the fraction of
 *      wall-clock time the runner would sit in `active`, which is what turns
 *      into recorded hours, notifications and accelerator time.
 *
 * "Subject present" is taken from what production itself concluded — the
 * `pipelineAnalytics.getObjectEvents` rows for the same window (`subjects`
 * command). That is a PROXY, not ground truth: it can only mark frames where
 * the full-frame detector already succeeded, so it understates recall on
 * exactly the small subjects this work exists to recover. Camera 101 also has
 * human-read ground truth (`scripts/motion-crop-recall/ground-truth.json` on
 * the branch that produced the recall report), and the two are reported
 * separately for that reason.
 *
 * WHAT IT MUTATES: nothing. Footage is read through `recording.readWindowBytes`
 * (a byte-range cut, no transcode); no detector, no pipeline, no settings write.
 *
 * TRAPS, inherited from the recall harness and re-learned here:
 *  - Runs must stay SERIAL. This one makes no detector calls, so it cannot be
 *    shed — but it does pull footage off the hub's disks, and two of them
 *    interleaved will distort the pacing figures.
 *  - The motion view is NOT 320x180 on every camera. It is 320x320 CONTAIN, so
 *    a 4:3 camera is analysed at 320x240 = 76 800 px and a 16:9 one at
 *    320x180 = 57 600 px. An absolute pixel bar therefore already means two
 *    different things on one hub today; the view size is probed per camera and
 *    reported with every number.
 *  - `fps=<motionFps>` in the decode gives frame pairs exactly `1000/motionFps`
 *    apart, which is the production inter-frame lag. Do not decode at the
 *    stream's own rate and subsample — the diff would be taken over a
 *    different interval and every area figure would move.
 *
 * HOW TO RE-RUN
 * -------------
 *   npx tsx scripts/motion-region-area-eval.mts scan <deviceId> <fromISO> <toISO> <out.jsonl>
 *   npx tsx scripts/motion-region-area-eval.mts subjects <deviceId> <fromISO> <toISO> <out.json>
 *   npx tsx scripts/motion-region-area-eval.mts report <out.jsonl> [more.jsonl ...]
 *   npx tsx scripts/motion-region-area-eval.mts gt <ground-truth.json> <recall.jsonl ...>
 *
 * Hub access: the `camstack login` session through the shared resolver
 * (scripts/hub/credentials.mjs). Environment: `MRA_HUB` and `MRA_TOKEN_FILE` are
 * explicit overrides only, `MRA_PROFILE` (default `high`), `MRA_FPS`
 * (default 4 — the `motionFps` schema default).
 *
 * The measurement this produced: `docs/benchmarks/motion-region-area.md`.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveHubAuth, type HubAuth } from './hub/credentials.mjs'
import {
  groupMotionRegions,
  DEFAULT_MERGE_RADIUS_DIVISOR,
  DEFAULT_MIN_AREA_FRACTION,
  type MotionRegionInput,
  type RegionGroupingConfig,
} from '../packages/addon-pipeline/src/motion-wasm/region-grouping.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const TMP = join(REPO, 'scratchpad', 'motion-area', 'tmp')
const WASM_PATH = join(REPO, 'packages', 'addon-pipeline', 'wasm', 'motion.wasm')

/**
 * The `low` profile is the SUB stream — 640x360-class pixels with the same
 * compression noise the live motion path actually reads. The recall report had
 * to downscale the 4K `main` recording instead and flagged that as its main
 * caveat; here the faithful source is available, so it is the default.
 */
const PROFILE = process.env['MRA_PROFILE'] ?? 'low'
/** `motionFps` — pipeline-runner.cap.ts default. */
const MOTION_FPS = Number(process.env['MRA_FPS'] ?? '4')
/** `MOTION_FRAME_VIEW.content` — the box the view is contained in. */
const VIEW_BOX = 320
/** `motionCooldownMs` — pipeline-runner.cap.ts default. What one motion frame costs. */
const COOLDOWN_MS = 30_000
/** Read footage in chunks this long; one `readWindowBytes` + one decode each. */
const CHUNK_MS = 30_000

/** The shipped per-region absolute bar this work replaces. */
const SHIPPED_MIN_AREA = 1500

// ── shapes ───────────────────────────────────────────────────────────────

export interface ScanFrame {
  readonly deviceId: number
  /** Epoch ms of the LATER frame of the diffed pair. */
  readonly t: number
  readonly viewW: number
  readonly viewH: number
  /** Every connected component, before any area filter. */
  readonly regions: ReadonlyArray<MotionRegionInput>
}

interface SubjectInterval {
  readonly fromMs: number
  readonly toMs: number
  readonly label: string
}

interface SubjectFile {
  readonly deviceId: number
  readonly intervals: ReadonlyArray<SubjectInterval>
}

// ── hub ──────────────────────────────────────────────────────────────────

// The hub serves its LAN API under a self-signed certificate; every operator
// tool in `scripts/` reaches it the same way.
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'

let hubAuth: HubAuth | null = null

/** The session through the shared resolver; called once, at the start of `main`. */
async function connectHub(): Promise<void> {
  const server = process.env['MRA_HUB']
  const tokenFile = process.env['MRA_TOKEN_FILE']
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
  readonly error?: unknown
  readonly result?: { readonly data?: { readonly json?: unknown } }
}

async function hubGet(path: string, input: unknown): Promise<unknown> {
  const url = `${connected().server}/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`
  const res = await fetch(url, { headers: { authorization: `Bearer ${bearer()}` } })
  const body = (await res.json()) as TrpcEnvelope
  if (body.error !== undefined) {
    throw new Error(`${path}: ${JSON.stringify(body.error).slice(0, 300)}`)
  }
  return body.result?.data?.json
}

// ── wasm ─────────────────────────────────────────────────────────────────

interface MotionExports {
  readonly memory: WebAssembly.Memory
  init(w: number, h: number): number
  getPrevOffset(): number
  getCurrOffset(): number
  getRegionOffset(): number
  detectMotion(threshold: number, blur: number, dilate: number, minArea: number): number
}

function isMotionExports(value: WebAssembly.Exports): value is WebAssembly.Exports & MotionExports {
  const v = value as Record<string, unknown>
  return (
    v['memory'] instanceof WebAssembly.Memory &&
    typeof v['init'] === 'function' &&
    typeof v['getPrevOffset'] === 'function' &&
    typeof v['getCurrOffset'] === 'function' &&
    typeof v['getRegionOffset'] === 'function' &&
    typeof v['detectMotion'] === 'function'
  )
}

/** The shipped `DEFAULT_CONFIG` of the motion-wasm addon, minus the area bar. */
const THRESHOLD = 45
const BLUR_RADIUS = 1
const DILATE_RADIUS = 4

class Motion {
  private prevOffset = 0
  private currOffset = 0
  private regionOffset = 0

  private constructor(private readonly wasm: MotionExports) {}

  static async load(): Promise<Motion> {
    const { instance } = await WebAssembly.instantiate(readFileSync(WASM_PATH), {
      env: {
        abort: () => {
          throw new Error('WASM abort')
        },
      },
    })
    if (!isMotionExports(instance.exports)) throw new Error('motion.wasm contract violation')
    return new Motion(instance.exports)
  }

  init(w: number, h: number): void {
    this.wasm.init(w, h)
    this.prevOffset = this.wasm.getPrevOffset()
    this.currOffset = this.wasm.getCurrOffset()
    this.regionOffset = this.wasm.getRegionOffset()
  }

  /** Every connected component — the JS-side area filter is the thing under study. */
  detect(prev: Uint8Array, curr: Uint8Array): ReadonlyArray<MotionRegionInput> {
    const mem = new Uint8Array(this.wasm.memory.buffer)
    mem.set(prev, this.prevOffset)
    mem.set(curr, this.currOffset)
    const n = this.wasm.detectMotion(THRESHOLD, BLUR_RADIUS, DILATE_RADIUS, 0)
    if (n === 0) return []
    const view = new DataView(this.wasm.memory.buffer)
    const out: MotionRegionInput[] = []
    for (let i = 0; i < n; i++) {
      const base = this.regionOffset + i * 20
      out.push({
        x: view.getInt32(base, true),
        y: view.getInt32(base + 4, true),
        w: view.getInt32(base + 8, true),
        h: view.getInt32(base + 12, true),
        pixels: view.getInt32(base + 16, true),
      })
    }
    return out
  }
}

// ── decode ───────────────────────────────────────────────────────────────

function ffmpeg(args: readonly string[]): void {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { maxBuffer: 1 << 28 })
}

function probeSize(path: string): { readonly w: number; readonly h: number } {
  const out = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=p=0',
      path,
    ],
    { encoding: 'utf8' },
  )
  const [w, h] = out.trim().split(',').map(Number)
  if (!w || !h) throw new Error(`ffprobe gave no size for ${path}`)
  return { w, h }
}

/**
 * `MOTION_FRAME_VIEW` is `content 320x320, fit contain` — so the view is the
 * largest box inside 320x320 with the source aspect ratio. A 16:9 camera gets
 * 320x180; a 4:3 one gets 320x240. Rounded to even dimensions, as any
 * yuv-based scaler must.
 */
export function motionViewSize(w: number, h: number): { readonly w: number; readonly h: number } {
  const scale = Math.min(VIEW_BOX / w, VIEW_BOX / h)
  const even = (v: number): number => Math.max(2, Math.round((v * scale) / 2) * 2)
  return { w: even(w), h: even(h) }
}

// ── scan ─────────────────────────────────────────────────────────────────

async function scan(
  deviceId: number,
  fromMs: number,
  toMs: number,
  outPath: string,
): Promise<void> {
  mkdirSync(TMP, { recursive: true })
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, '')

  const motion = await Motion.load()
  const mp4 = join(TMP, `seg-${deviceId}.mp4`)
  const raw = join(TMP, `seg-${deviceId}.raw`)
  let view: { w: number; h: number } | null = null
  let frames = 0
  let segmentsRead = 0
  let gaps = 0

  // Footage is stored as short segments (~12 s here), and `readWindowBytes`
  // refuses a window that leaves one. So the unit of work is the SEGMENT: it
  // is located, read whole, decoded once, and the cursor jumps to its end.
  let cursor = fromMs
  while (cursor < toMs) {
    const located = (await hubGet('recording.locateSegment', {
      deviceId,
      profile: PROFILE,
      epochMs: cursor,
    })) as { kind?: string; startMs?: number; durMs?: number; nearestEdgeMs?: number | null }

    if (
      located.kind !== 'segment' ||
      located.startMs === undefined ||
      located.durMs === undefined
    ) {
      gaps += 1
      const next = located.nearestEdgeMs
      cursor = typeof next === 'number' && next > cursor ? next : cursor + CHUNK_MS
      continue
    }
    const segStart = located.startMs
    const segEnd = segStart + located.durMs

    const read = (await hubGet('recording.readSegmentBytes', {
      deviceId,
      profile: PROFILE,
      startMs: segStart,
    })) as { data?: ArrayLike<number> }
    if (!read.data) {
      gaps += 1
      cursor = segEnd
      continue
    }
    writeFileSync(mp4, Buffer.from(read.data))
    segmentsRead += 1

    if (!view) {
      const size = probeSize(mp4)
      view = motionViewSize(size.w, size.h)
      motion.init(view.w, view.h)
      process.stderr.write(
        `device ${deviceId}: source ${size.w}x${size.h} => motion view ${view.w}x${view.h} (${view.w * view.h} px)\n`,
      )
    }

    // fps=MOTION_FPS gives pairs exactly 1000/MOTION_FPS apart — the
    // production inter-frame lag, not a subsample of the stream's own rate.
    ffmpeg([
      '-i',
      mp4,
      '-vf',
      `fps=${MOTION_FPS},scale=${view.w}:${view.h},format=gray`,
      '-f',
      'rawvideo',
      raw,
    ])
    const gray = readFileSync(raw)
    const frameBytes = view.w * view.h
    const count = Math.floor(gray.length / frameBytes)

    const lines: string[] = []
    for (let i = 1; i < count; i++) {
      const t = segStart + Math.round((i * 1000) / MOTION_FPS)
      if (t < fromMs || t > toMs) continue
      const prev = gray.subarray((i - 1) * frameBytes, i * frameBytes)
      const curr = gray.subarray(i * frameBytes, (i + 1) * frameBytes)
      const row: ScanFrame = {
        deviceId,
        t,
        viewW: view.w,
        viewH: view.h,
        regions: motion.detect(prev, curr),
      }
      lines.push(JSON.stringify(row))
      frames += 1
    }
    if (lines.length > 0) appendFileSync(outPath, `${lines.join('\n')}\n`)
    if (segmentsRead % 20 === 0) {
      process.stderr.write(`  ${new Date(segStart).toISOString()}  frames=${frames}\n`)
    }
    cursor = segEnd
  }

  process.stderr.write(
    `scan done: device ${deviceId}, ${frames} frames, ${segmentsRead} segments read, ${gaps} gaps => ${outPath}\n`,
  )
}

// ── subjects ─────────────────────────────────────────────────────────────

/**
 * "A subject was present" taken from what production concluded on the same
 * window. A proxy for ground truth, and a conservative one: it can only mark
 * frames the full-frame detector already succeeded on.
 */
async function subjects(
  deviceId: number,
  fromMs: number,
  toMs: number,
  outPath: string,
): Promise<void> {
  const rows = (await hubGet('pipelineAnalytics.getObjectEvents', {
    deviceId,
    since: fromMs,
    until: toMs,
    limit: 1000,
    projection: 'slim',
  })) as ReadonlyArray<Record<string, unknown>>

  // A row is one detection INSTANT on one track. The interval a subject was
  // present for is the span of its track's instants, widened by one motion
  // frame period at each end so a frame on the scan cadence lands inside it.
  const halfPeriod = Math.round(500 / MOTION_FPS)
  const byTrack = new Map<string, { from: number; to: number; label: string }>()
  for (const row of rows) {
    const t = Number(row['timestamp'] ?? NaN)
    if (!Number.isFinite(t)) continue
    const track = String(row['trackId'] ?? row['id'] ?? t)
    const label = String(row['className'] ?? 'object')
    const seen = byTrack.get(track)
    if (!seen) {
      byTrack.set(track, { from: t, to: t, label })
      continue
    }
    seen.from = Math.min(seen.from, t)
    seen.to = Math.max(seen.to, t)
  }
  const intervals: SubjectInterval[] = [...byTrack.values()].map((v) => ({
    fromMs: v.from - halfPeriod,
    toMs: v.to + halfPeriod,
    label: v.label,
  }))
  mkdirSync(dirname(outPath), { recursive: true })
  const file: SubjectFile = { deviceId, intervals }
  writeFileSync(outPath, `${JSON.stringify(file, null, 2)}\n`)
  process.stderr.write(`${intervals.length} subject intervals => ${outPath}\n`)
}

// ── report ───────────────────────────────────────────────────────────────

function quantiles(values: readonly number[]): string {
  if (values.length === 0) return 'n=0'
  const s = [...values].sort((a, b) => a - b)
  const at = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))]!
  return `n=${s.length} min=${s[0]} p10=${at(0.1)} p25=${at(0.25)} med=${at(0.5)} p75=${at(0.75)} p90=${at(0.9)} max=${s[s.length - 1]}`
}

/**
 * A config for the MEASURED rule. `minArea` is pinned to 0 throughout: a
 * positive one would switch the pure function to the legacy per-component rule,
 * which is the shipped default but not what this harness is sweeping. Where the
 * legacy rule is the comparison, it is computed directly (`perRegion`).
 */
function config(
  viewW: number,
  viewH: number,
  fraction: number,
  maxCoverageFraction = 1,
): RegionGroupingConfig {
  return {
    viewWidth: viewW,
    viewHeight: viewH,
    mergeRadiusDivisor: DEFAULT_MERGE_RADIUS_DIVISOR,
    minAreaFraction: fraction,
    minArea: 0,
    maxCoverageFraction,
  }
}

/**
 * Contiguous stretches of scanned footage. Windows scanned hours apart must
 * not share a duty-cycle denominator — a 20-minute night window and a
 * 20-minute day window are 40 minutes of evidence, not 13 hours of it.
 */
function windows(frames: readonly ScanFrame[]): ReadonlyArray<{ from: number; to: number }> {
  const gapMs = 60_000
  const out: { from: number; to: number }[] = []
  for (const f of frames) {
    const last = out[out.length - 1]
    if (last && f.t - last.to <= gapMs) {
      last.to = f.t
      continue
    }
    out.push({ from: f.t, to: f.t })
  }
  return out
}

/** Wall-clock fraction the runner would spend `active`: each firing frame arms `COOLDOWN_MS`. */
function dutyCycleIn(firingTimes: readonly number[], fromMs: number, toMs: number): number {
  if (firingTimes.length === 0) return 0
  const span = Math.max(1, toMs - fromMs)
  const sorted = [...firingTimes].sort((a, b) => a - b)
  let covered = 0
  let openFrom = sorted[0]!
  let openTo = sorted[0]! + COOLDOWN_MS
  for (const t of sorted.slice(1)) {
    if (t <= openTo) {
      openTo = t + COOLDOWN_MS
      continue
    }
    covered += openTo - openFrom
    openFrom = t
    openTo = t + COOLDOWN_MS
  }
  covered += openTo - openFrom
  return Math.min(1, covered / span)
}

/** Duty cycle over every scanned window, weighted by each window's length. */
function dutyCycle(
  firingTimes: readonly number[],
  spans: ReadonlyArray<{ from: number; to: number }>,
): number {
  let covered = 0
  let total = 0
  for (const span of spans) {
    const inside = firingTimes.filter((t) => t >= span.from && t <= span.to)
    const length = Math.max(1, span.to - span.from)
    covered += dutyCycleIn(inside, span.from, span.to) * length
    total += length
  }
  return total === 0 ? 0 : covered / total
}

const SWEEP: readonly number[] = [0.002, 0.004, 0.006, 0.0085, 0.01, 0.0125, 0.0156, 0.02, 0.026]

function report(paths: readonly string[]): void {
  const byDevice = new Map<number, ScanFrame[]>()
  for (const path of paths) {
    for (const line of readFileSync(path, 'utf8').trim().split('\n')) {
      if (line.length === 0) continue
      const row = JSON.parse(line) as ScanFrame
      const list = byDevice.get(row.deviceId) ?? []
      list.push(row)
      byDevice.set(row.deviceId, list)
    }
  }

  for (const [deviceId, framesUnsorted] of [...byDevice].sort((a, b) => a[0] - b[0])) {
    const frames = [...framesUnsorted].sort((a, b) => a.t - b.t)
    const viewW = frames[0]!.viewW
    const viewH = frames[0]!.viewH
    const viewArea = viewW * viewH
    const spans = windows(frames)
    const scannedMs = spans.reduce((acc, s) => acc + (s.to - s.from), 0)
    const subjectPath = join(dirname(paths[0]!), `subjects-${deviceId}.json`)
    const subjectFile: SubjectFile | null = existsSync(subjectPath)
      ? (JSON.parse(readFileSync(subjectPath, 'utf8')) as SubjectFile)
      : null
    const inSubject = (t: number): boolean =>
      subjectFile?.intervals.some((i) => t >= i.fromMs && t <= i.toMs) ?? false

    console.log(`\n══ device ${deviceId} — motion view ${viewW}x${viewH} (${viewArea} px)`)
    console.log(
      `   ${frames.length} frames at ${MOTION_FPS} fps over ${spans.length} window(s), ${(scannedMs / 60000).toFixed(1)} min of footage:`,
    )
    for (const span of spans) {
      console.log(
        `     ${new Date(span.from).toISOString()} → ${new Date(span.to).toISOString()} (${((span.to - span.from) / 60000).toFixed(1)} min)`,
      )
    }

    // ── the two distributions, ungated: largest merged group per frame
    const largest = (f: ScanFrame): number => {
      const groups = groupMotionRegions(f.regions, config(viewW, viewH, 0)).groups
      return groups.length === 0 ? 0 : Math.max(...groups.map((g) => g.pixels))
    }
    const subjectFrames = frames.filter((f) => inSubject(f.t))
    const quietFrames = frames.filter((f) => !inSubject(f.t))
    const subjectAreas = subjectFrames.map(largest).filter((v) => v > 0)
    const quietAreas = quietFrames.map(largest).filter((v) => v > 0)
    console.log(`   subject frames ${subjectFrames.length}, with a region: ${subjectAreas.length}`)
    console.log(`     largest merged group, px : ${quantiles(subjectAreas)}`)
    console.log(
      `     as % of the view          : ${quantiles(subjectAreas.map((v) => Math.round((10000 * v) / viewArea) / 100))}`,
    )
    console.log(`   quiet frames ${quietFrames.length}, with a region: ${quietAreas.length}`)
    console.log(`     largest merged group, px : ${quantiles(quietAreas)}`)
    console.log(
      `     as % of the view          : ${quantiles(quietAreas.map((v) => Math.round((10000 * v) / viewArea) / 100))}`,
    )

    // ── the sweep: what each bar fires on, and what it costs in duty cycle
    const shippedFiring = frames
      .filter((f) => f.regions.some((r) => r.pixels >= SHIPPED_MIN_AREA))
      .map((f) => f.t)
    console.log(
      `\n   shipped rule (per-region minArea ${SHIPPED_MIN_AREA}, no merge): fires on ${shippedFiring.length}/${frames.length} frames (${((100 * shippedFiring.length) / frames.length).toFixed(2)}%), duty cycle ${(100 * dutyCycle(shippedFiring, spans)).toFixed(2)}%`,
    )
    console.log('\n   bar      px    frames firing      duty cycle   subject frames hit')
    for (const frac of SWEEP) {
      const firing: number[] = []
      let subjectHit = 0
      for (const f of frames) {
        const out = groupMotionRegions(f.regions, config(viewW, viewH, frac))
        if (out.passed.length === 0) continue
        firing.push(f.t)
        if (inSubject(f.t)) subjectHit += 1
      }
      const duty = dutyCycle(firing, spans)
      console.log(
        `   ${(frac * 100).toFixed(2)}%  ${String(Math.round(frac * viewArea)).padStart(5)}   ` +
          `${String(firing.length).padStart(6)}/${frames.length} (${((100 * firing.length) / frames.length).toFixed(2)}%)   ` +
          `${(100 * duty).toFixed(2)}%`.padStart(9) +
          `      ${subjectHit}/${subjectFrames.length}`,
      )
    }

    // ── what the storm breaker actually removes at the chosen bar
    for (const cover of [0.7, 0.5, 0.4, 0.25]) {
      const firing: number[] = []
      let subjectHit = 0
      let suppressed = 0
      let rescued = 0
      for (const f of frames) {
        const out = groupMotionRegions(
          f.regions,
          config(viewW, viewH, DEFAULT_MIN_AREA_FRACTION, cover),
        )
        suppressed += out.suppressedByCoverage
        if (out.suppressedByCoverage > 0 && out.passed.length > 0) rescued += 1
        if (out.passed.length === 0) continue
        firing.push(f.t)
        if (inSubject(f.t)) subjectHit += 1
      }
      console.log(
        `   storm cutoff ${(100 * cover).toFixed(0)}% at bar ${(100 * DEFAULT_MIN_AREA_FRACTION).toFixed(2)}%: ` +
          `${firing.length}/${frames.length} firing, duty ${(100 * dutyCycle(firing, spans)).toFixed(2)}%, ` +
          `${suppressed} groups suppressed (${rescued} frames still fired on a component), subjects ${subjectHit}/${subjectFrames.length}`,
      )
    }

    // ── the storm tail: how much of the view one merged group ever covers
    const coverage = frames
      .map((f) => largest(f) / viewArea)
      .filter((v) => v > 0)
      .map((v) => Math.round(v * 1000) / 10)
    console.log(`\n   largest group as % of view: ${quantiles(coverage)}`)
    const over = (p: number): number => coverage.filter((v) => v >= p).length
    console.log(
      `   frames with a group over 25%/40%/50%/70% of the view: ${over(25)} / ${over(40)} / ${over(50)} / ${over(70)}`,
    )
  }
}

// ── ground-truth corpus ──────────────────────────────────────────────────

interface RecallRow {
  readonly t: number
  /** `event` windows surround a known pass-by; `quiet` ones are the negatives. */
  readonly kind?: string
  readonly motion?: {
    readonly rawRegions?: ReadonlyArray<{
      readonly x: number
      readonly y: number
      readonly w: number
      readonly h: number
      readonly px?: number
      readonly pixels?: number
    }>
  }
}

interface GroundTruthFile {
  readonly intervals: ReadonlyArray<{ readonly fromMs: number; readonly toMs: number }>
}

/**
 * The human-read corpus behind `docs/benchmarks/motion-crop-recall.md`: 38
 * frames on camera 101 with a visually confirmed animal, against ~3000 frames
 * of quiet and adversarial footage from the same camera. Its jsonl carries
 * `motion.rawRegions` per instant, which is all this analysis needs — so the
 * area rule can be re-scored on human ground truth without re-running any
 * detector.
 *
 * Inputs live on the branch that produced that report
 * (`scripts/motion-crop-recall/ground-truth.json` plus its result jsonl).
 */
function groundTruth(gtPath: string, paths: readonly string[]): void {
  const gt = JSON.parse(readFileSync(gtPath, 'utf8')) as GroundTruthFile
  const positive = (t: number): boolean => gt.intervals.some((i) => t >= i.fromMs && t <= i.toMs)

  const byInstant = new Map<number, MotionRegionInput[]>()
  for (const path of paths) {
    for (const line of readFileSync(path, 'utf8').trim().split('\n')) {
      if (line.length === 0) continue
      const row = JSON.parse(line) as RecallRow
      const raw = row.motion?.rawRegions
      if (!raw) continue
      const regions = raw.map((r) => ({
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
        pixels: r.px ?? r.pixels ?? 0,
      }))
      // The same instants were measured in several runs; motion is
      // deterministic on the same pair, so first non-empty wins.
      // A frame inside an event window but outside the presence interval is
      // NOT a negative — the subject may be entering or leaving. The recall
      // report's convention; negatives come only from quiet windows.
      if (row.kind === 'event' && !positive(row.t)) continue
      const seen = byInstant.get(row.t)
      if (seen === undefined || (seen.length === 0 && regions.length > 0)) {
        byInstant.set(row.t, regions)
      }
    }
  }

  const tp = [...byInstant].filter(([t]) => positive(t)).map(([, r]) => r)
  const quiet = [...byInstant].filter(([t]) => !positive(t)).map(([, r]) => r)
  // The recall corpus is 16:9 at the production motion view.
  const viewW = 320
  const viewH = 180

  const fires = (regions: MotionRegionInput[], frac: number): boolean =>
    groupMotionRegions(regions, config(viewW, viewH, frac)).passed.length > 0
  /** The merged rule expressed at an ABSOLUTE bar, for the shape-vs-value table. */
  const firesAt = (regions: MotionRegionInput[], bar: number): boolean =>
    fires(regions, bar / (viewW * viewH))
  const perRegion = (regions: MotionRegionInput[], bar: number): boolean =>
    regions.some((r) => r.pixels >= bar)

  console.log(`\nground truth: ${tp.length} positive frames, ${quiet.length} quiet frames`)
  const largest = (regions: MotionRegionInput[]): number => {
    const groups = groupMotionRegions(regions, config(viewW, viewH, 0)).groups
    return groups.length === 0 ? 0 : Math.max(...groups.map((g) => g.pixels))
  }
  console.log(
    `  positive, largest merged group: ${quantiles(tp.map(largest).filter((v) => v > 0))}`,
  )
  console.log(
    `  quiet,    largest merged group: ${quantiles(quiet.map(largest).filter((v) => v > 0))}`,
  )
  console.log(
    `  positive frames with NO component at all: ${tp.filter((r) => r.length === 0).length}`,
  )

  console.log('\n  rule                                  positive        quiet')
  const line = (label: string, hitTp: number, hitQuiet: number): void => {
    console.log(
      `  ${label.padEnd(36)} ${hitTp}/${tp.length} (${((100 * hitTp) / tp.length).toFixed(0)}%)   ` +
        `${hitQuiet}/${quiet.length} (${((100 * hitQuiet) / quiet.length).toFixed(2)}%)`,
    )
  }
  for (const bar of [1500, 490]) {
    line(
      `per-region, ${bar} px${bar === SHIPPED_MIN_AREA ? ' (shipped)' : ''}`,
      tp.filter((r) => perRegion(r, bar)).length,
      quiet.filter((r) => perRegion(r, bar)).length,
    )
    line(
      `merged,     ${bar} px`,
      tp.filter((r) => firesAt(r, bar)).length,
      quiet.filter((r) => firesAt(r, bar)).length,
    )
  }

  console.log('\n  bar      px   positive         quiet')
  for (const frac of SWEEP) {
    console.log(
      `  ${(frac * 100).toFixed(2)}%  ${String(Math.round(frac * viewW * viewH)).padStart(5)}  ` +
        `${tp.filter((r) => fires(r, frac)).length}/${tp.length}`.padStart(9) +
        `        ${quiet.filter((r) => fires(r, frac)).length}/${quiet.length}`,
    )
  }
}

// ── main ─────────────────────────────────────────────────────────────────

function parseTime(value: string): number {
  const asNumber = Number(value)
  if (Number.isFinite(asNumber) && value.trim() !== '') return asNumber
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`unparseable time: ${value}`)
  return parsed
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  // `report` and `gt` read local files only; the rest talk to the hub.
  if (command === 'scan' || command === 'subjects') await connectHub()
  switch (command) {
    case 'scan': {
      const [deviceId, from, to, out] = rest
      if (!deviceId || !from || !to || !out)
        throw new Error('scan <deviceId> <from> <to> <out.jsonl>')
      await scan(Number(deviceId), parseTime(from), parseTime(to), out)
      return
    }
    case 'subjects': {
      const [deviceId, from, to, out] = rest
      if (!deviceId || !from || !to || !out)
        throw new Error('subjects <deviceId> <from> <to> <out.json>')
      await subjects(Number(deviceId), parseTime(from), parseTime(to), out)
      return
    }
    case 'gt': {
      const [gtPath, ...jsonl] = rest
      if (!gtPath || jsonl.length === 0)
        throw new Error('gt <ground-truth.json> <recall.jsonl ...>')
      groundTruth(gtPath, jsonl)
      return
    }
    case 'report': {
      if (rest.length === 0) throw new Error('report <out.jsonl> [more.jsonl ...]')
      report(rest)
      return
    }
    default:
      throw new Error(`unknown command ${String(command)} — see the docblock`)
  }
}

await main()
