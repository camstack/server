#!/usr/bin/env tsx
/**
 * Local cost gate for the D683 appearance descriptor. Decodes a recorded clip
 * at the tape's analysis size and 10 fps, feeds each tape frame's first-level
 * boxes through the SAME `attachAppearanceDescriptors` the runner uses (the
 * inline-RGB view path), and reports per-box and per-frame p50/p95. Exit 1 when
 * the per-frame p95 exceeds the budget.
 *
 *   npx tsx packages/addon-pipeline/scripts/appearance-cost-bench.ts --clip <mp4> --tape <tape.jsonl.gz> [--scope all|candidates]
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import type { FrameResult } from '@camstack/types'
import sharp from 'sharp'
import {
  type AppearanceScope,
  attachAppearanceDescriptors,
} from '../src/pipeline-runner/appearance-attach.js'
import { APPEARANCE_VIEW, overlapsSameClass } from '../src/pipeline-runner/appearance-descriptor.js'

/** Mac per-frame p95 budget. The N100 runs this path ~3× slower: 1.0 ms here ≈ 3 ms there,
 *  i.e. ≤ 3 % of one N100 core per camera at 10 fps. */
const FRAME_P95_BUDGET_MS = 1.0

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function p(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
}

async function decode(clip: string, w: number, h: number): Promise<Buffer[]> {
  const frames: Buffer[] = []
  const ff = spawn('ffmpeg', [
    '-v',
    'error',
    '-i',
    clip,
    '-vf',
    `fps=10,scale=${w}:${h}`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-',
  ])
  let pending = Buffer.alloc(0)
  for await (const chunk of ff.stdout) {
    if (!Buffer.isBuffer(chunk)) continue
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= w * h * 3) {
      frames.push(pending.subarray(0, w * h * 3))
      pending = pending.subarray(w * h * 3)
    }
  }
  return frames
}

async function main(): Promise<number> {
  const clip = arg('clip')
  const tapePath = arg('tape')
  const scope: AppearanceScope = arg('scope') === 'candidates' ? 'candidates' : 'all'
  if (clip === undefined || tapePath === undefined) {
    process.stderr.write('usage: --clip <mp4> --tape <tape.jsonl.gz> [--scope all|candidates]\n')
    return 2
  }
  const frames = await readBenchFrames(tapePath)
  const first = frames[0]
  if (first === undefined) return 2
  const raster = await decode(clip, first.w, first.h)
  const perFrame: number[] = []
  const perBox: number[] = []
  for (const r of frames) {
    const pixels = raster[Math.floor(r.t / 100)]
    if (pixels === undefined) break
    const result: FrameResult = {
      kind: 'frame',
      frameId: String(r.t),
      deviceId: 0,
      timestamp: r.t,
      width: r.w,
      height: r.h,
      detections: r.dets
        .filter((d) => d.k === 'first-level')
        .map((d) => ({
          id: d.id,
          kind: 'first-level' as const,
          macroClass: d.cls,
          score: d.s,
          labels: [],
          bbox: { x: d.b[0], y: d.b[1], width: d.b[2], height: d.b[3] },
        })),
    }
    const started = performance.now()
    const out = await attachAppearanceDescriptors(
      result,
      async (crop) => {
        const data = await sharp(pixels, { raw: { width: r.w, height: r.h, channels: 3 } })
          .extract(crop)
          .resize(APPEARANCE_VIEW.width, APPEARANCE_VIEW.height, { fit: 'fill' })
          .raw()
          .toBuffer()
        return {
          data: new Uint8Array(data),
          width: APPEARANCE_VIEW.width,
          height: APPEARANCE_VIEW.height,
        }
      },
      // The bench cannot know the runner's novelty memory: count every box as novel in 'candidates'
      // only when it overlaps another of its class — a LOWER bound on that scope's work.
      { scope, isCandidate: (i) => overlapsSameClass(result.detections, i) },
    )
    const ms = performance.now() - started
    perFrame.push(ms)
    if (out.cost.attached > 0) perBox.push(ms / out.cost.attached)
  }
  const frameP95 = p(perFrame, 0.95)
  process.stdout.write(
    `frames=${perFrame.length} box p50=${p(perBox, 0.5).toFixed(3)} p95=${p(perBox, 0.95).toFixed(3)} ms; frame p50=${p(perFrame, 0.5).toFixed(3)} p95=${frameP95.toFixed(3)} ms; budget ${FRAME_P95_BUDGET_MS} ms; scope=${scope}\n`,
  )
  return frameP95 <= FRAME_P95_BUDGET_MS ? 0 : 1
}

/** The few tape fields the bench reads. The bench does not import D681's codec
 *  (review 2 L6: an `addon-pipeline` script must not reach into another
 *  package's source); it reads the JSON lines and keeps what this guard accepts. */
interface BenchDet {
  readonly id: string
  readonly k: string
  readonly cls: string
  readonly s: number
  readonly b: readonly [number, number, number, number]
}
interface BenchFrame {
  readonly t: number
  readonly w: number
  readonly h: number
  readonly dets: readonly BenchDet[]
}

function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function toBenchDet(v: unknown): BenchDet | null {
  if (!isRecord(v)) return null
  const { id, k, cls, s, b } = v
  if (
    typeof id !== 'string' ||
    typeof k !== 'string' ||
    typeof cls !== 'string' ||
    typeof s !== 'number'
  )
    return null
  if (!Array.isArray(b) || b.length !== 4) return null
  const [x, y, w, h] = b
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof w !== 'number' ||
    typeof h !== 'number'
  )
    return null
  return { id, k, cls, s, b: [x, y, w, h] }
}

async function readBenchFrames(path: string): Promise<readonly BenchFrame[]> {
  const raw = await readFile(path)
  const text = path.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8')
  const out: BenchFrame[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const r: unknown = JSON.parse(line)
    if (!isRecord(r) || r['kind'] !== 'frame') continue
    const { t, w, h, dets } = r
    if (
      typeof t !== 'number' ||
      typeof w !== 'number' ||
      typeof h !== 'number' ||
      !Array.isArray(dets)
    )
      continue
    out.push({ t, w, h, dets: dets.map(toBenchDet).filter((d): d is BenchDet => d !== null) })
  }
  return out
}

main().then((code) => process.exit(code))
