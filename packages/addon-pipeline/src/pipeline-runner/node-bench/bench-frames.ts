/**
 * The frames a node benchmark runs on (D791), decoded ONCE on the node into
 * RAM at the detection size — never shipped across a process per call (D9).
 *
 * Source, in order:
 *  1. the public bench clip (`camstack-bench-v1`, CC-licensed composite with
 *     a synthetic plate — `docs/benchmarks/bench-clip.md`), downloaded once
 *     into the runner's data dir and accepted ONLY when its sha256 matches
 *     the pinned revision; decoded with the node's pinned ffmpeg;
 *  2. otherwise the executor's reference images (always on the node). The
 *     run says which (`clip.id`), so a result never claims the clip it did
 *     not use.
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import type { NodeBenchClip } from '@camstack/types'
import type { BenchFrame } from './node-bench-driver.js'

/**
 * The published clip, pinned to the exact build uploaded to the HF dataset
 * repo (`scripts/bench-clip/build-bench-clip.sh` prints the hash). A download
 * that fails (not uploaded yet) or whose bytes differ falls back to the
 * reference images, and the run says so. `sha256: null` disables the clip.
 */
export const BENCH_CLIP = {
  id: 'camstack-bench-v1',
  revision: 'v1',
  fileName: 'camstack-bench-v1-h264-1080p.mp4',
  url: 'https://huggingface.co/datasets/camstack/camstack-bench-clips/resolve/main/camstack-bench-v1/camstack-bench-v1-h264-1080p.mp4',
  sha256: '677eea6ccb5711dafe70ac7259aa152b8fad3e5704da1a8a8c66e6b1717f1434' as string | null,
} as const

/** Detection-size frames (16:9 clip → 640×360). */
export const BENCH_FRAME_WIDTH = 640
export const BENCH_FRAME_HEIGHT = 360
/** One frame a second over the ~2 min clip: every segment is represented. */
export const BENCH_FRAME_COUNT = 120

export interface BenchFrameSet {
  readonly frames: readonly BenchFrame[]
  readonly clip: NodeBenchClip
}

export interface BenchFrameDeps {
  readonly dataDir: string
  readonly ensureFfmpeg: () => Promise<string>
  readonly fetch: typeof fetch
  /** JPEG bytes of every reference image on the node. */
  readonly referenceImages: () => Promise<readonly Uint8Array[]>
  /** JPEG → raw RGB at most `maxWidth` wide. */
  readonly decodeJpeg: (jpeg: Uint8Array, maxWidth: number) => Promise<BenchFrame>
  readonly log: (message: string, meta?: Record<string, unknown>) => void
  readonly clip?: typeof BENCH_CLIP
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** The verified clip on disk, downloading it when absent or wrong. Null when unavailable. */
export async function ensureBenchClip(deps: BenchFrameDeps): Promise<string | null> {
  const clip = deps.clip ?? BENCH_CLIP
  if (clip.sha256 === null) return null
  const dir = path.join(deps.dataDir, 'bench')
  const file = path.join(dir, clip.fileName)
  try {
    if ((await sha256Of(file)) === clip.sha256) return file
  } catch {
    // absent — download below
  }
  await fs.mkdir(dir, { recursive: true })
  const staged = `${file}.downloading`
  const res = await deps.fetch(clip.url)
  if (!res.ok || res.body === null) throw new Error(`bench clip download: HTTP ${res.status}`)
  await fs.writeFile(staged, new Uint8Array(await res.arrayBuffer()))
  const got = await sha256Of(staged)
  if (got !== clip.sha256) {
    await fs.rm(staged, { force: true })
    throw new Error(`bench clip download: sha256 ${got} is not the pinned ${clip.sha256}`)
  }
  await fs.rename(staged, file)
  return file
}

/** Decode `count` evenly spread frames of `file` to raw RGB with the node's ffmpeg. */
export async function decodeClipFrames(
  ffmpeg: string,
  file: string,
  count: number,
): Promise<readonly BenchFrame[]> {
  const frameBytes = BENCH_FRAME_WIDTH * BENCH_FRAME_HEIGHT * 3
  const args = [
    '-v',
    'error',
    '-i',
    file,
    '-vf',
    `fps=1,scale=${BENCH_FRAME_WIDTH}:${BENCH_FRAME_HEIGHT}`,
    '-frames:v',
    String(count),
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    'pipe:1',
  ]
  const chunks: Buffer[] = []
  const stderr: Buffer[] = []
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    child.stderr.on('data', (c: Buffer) => stderr.push(c))
    child.on('error', reject)
    child.on('close', resolve)
  })
  if (code !== 0) {
    throw new Error(
      `bench clip decode failed (${code}): ${Buffer.concat(stderr).toString().slice(0, 300)}`,
    )
  }
  const all = Buffer.concat(chunks)
  const frames: BenchFrame[] = []
  for (let off = 0; off + frameBytes <= all.length; off += frameBytes) {
    frames.push({
      data: new Uint8Array(all.subarray(off, off + frameBytes)),
      width: BENCH_FRAME_WIDTH,
      height: BENCH_FRAME_HEIGHT,
    })
  }
  return frames
}

/** The clip's frames, else the reference images'. Throws only when neither yields a frame. */
export async function loadBenchFrames(deps: BenchFrameDeps): Promise<BenchFrameSet> {
  const clip = deps.clip ?? BENCH_CLIP
  try {
    const file = await ensureBenchClip(deps)
    if (file !== null) {
      const frames = await decodeClipFrames(await deps.ensureFfmpeg(), file, BENCH_FRAME_COUNT)
      if (frames.length > 0) {
        return {
          frames,
          clip: {
            id: clip.id,
            revision: clip.revision,
            frames: frames.length,
            width: BENCH_FRAME_WIDTH,
            height: BENCH_FRAME_HEIGHT,
          },
        }
      }
    } else {
      deps.log('bench clip not published yet — measuring on the reference images')
    }
  } catch (err) {
    deps.log('bench clip unavailable — measuring on the reference images', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  const frames: BenchFrame[] = []
  for (const jpeg of await deps.referenceImages()) {
    try {
      frames.push(await deps.decodeJpeg(jpeg, BENCH_FRAME_WIDTH))
    } catch {
      // an unreadable reference image is skipped
    }
  }
  if (frames.length === 0)
    throw new Error('node bench: neither the bench clip nor a reference image could be decoded')
  return {
    frames,
    clip: {
      id: 'reference-images',
      revision: null,
      frames: frames.length,
      width: frames[0]?.width ?? 0,
      height: frames[0]?.height ?? 0,
    },
  }
}
