/**
 * D1078 — the encoded stream the decode measurement offers is built ON the
 * node, once per profile, and cached. A node that cannot build it (no encoder,
 * a file without access-unit delimiters) gets a reason, never a stream.
 */
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { NodeDecodeProfile } from '@dominevo/types'
import { afterEach, describe, expect, it } from 'vitest'
import {
  decodeSourceArgs,
  type DecodeSourceDeps,
  ensureDecodeBenchSource,
} from '../decode-bench-source.js'

const UHD: NodeDecodeProfile = {
  width: 3840,
  height: 2160,
  fps: 15,
  codec: 'h265',
}
const FHD: NodeDecodeProfile = {
  width: 1920,
  height: 1080,
  fps: 15,
  codec: 'h264',
}

/** 30 H.264 access units, an IDR every 15. */
function fakeStream(): Buffer {
  const parts: number[] = []
  for (let i = 0; i < 30; i++) {
    parts.push(0, 0, 0, 1, 0x69, 0x10, 0, 0, 1, i % 15 === 0 ? 0x65 : 0x61, i, i)
  }
  return Buffer.from(parts)
}

const dirs: string[] = []
async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'decode-src-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function deps(dataDir: string, over: Partial<DecodeSourceDeps> = {}): DecodeSourceDeps {
  return {
    dataDir,
    ensureFfmpeg: async () => '/bin/ffmpeg',
    clipFile: async () => null,
    runFfmpeg: async (_bin, args) => {
      await writeFile(args.at(-1) ?? '', fakeStream())
      return { code: 0, stderr: '' }
    },
    log: () => undefined,
    ...over,
  }
}

describe('decodeSourceArgs', () => {
  it('encodes the profile: size, rate, codec, one keyframe a second, delimiters, no B-frames', () => {
    const args = decodeSourceArgs(UHD, null, '/out.hevc')
    expect(args.join(' ')).toContain('testsrc2=size=3840x2160:rate=15')
    expect(args).toContain('libx265')
    expect(args[args.indexOf('-g') + 1]).toBe('15')
    expect(args[args.indexOf('-bf') + 1]).toBe('0')
    expect(args[args.indexOf('-x265-params') + 1]).toContain('aud=1')
    expect(args.slice(-3)).toEqual(['-f', 'hevc', '/out.hevc'])
  })
  it('reads the verified bench clip when the node has it, scaled to the profile', () => {
    const args = decodeSourceArgs(FHD, '/data/bench/clip.mp4', '/out.h264')
    expect(args[args.indexOf('-i') + 1]).toBe('/data/bench/clip.mp4')
    expect(args[args.indexOf('-vf') + 1]).toContain('scale=1920:1080')
    expect(args).toContain('libx264')
    expect(args[args.indexOf('-x264-params') + 1]).toContain('aud=1')
  })
})

describe('ensureDecodeBenchSource', () => {
  it('builds the stream once and reads it from the cache afterwards', async () => {
    const dataDir = await tmp()
    let runs = 0
    const d = deps(dataDir, {
      runFfmpeg: async (_bin, args) => {
        runs += 1
        await writeFile(args.at(-1) ?? '', fakeStream())
        return { code: 0, stderr: '' }
      },
    })
    const first = await ensureDecodeBenchSource(d, FHD)
    const second = await ensureDecodeBenchSource(d, FHD)
    expect(first.kind).toBe('ready')
    expect(second.kind).toBe('ready')
    expect(runs).toBe(1)
    if (first.kind !== 'ready') return
    expect(first.source.accessUnits).toHaveLength(30)
    expect(first.source.accessUnits[0]?.keyframe).toBe(true)
    expect(first.source.origin).toBe('synthetic')
  })

  it('an encoder the node lacks is a reason, and leaves no file behind', async () => {
    const dataDir = await tmp()
    const out = await ensureDecodeBenchSource(
      deps(dataDir, {
        runFfmpeg: async () => ({
          code: 1,
          stderr: "Unknown encoder 'libx265'",
        }),
      }),
      UHD,
    )
    expect(out).toEqual({
      kind: 'skipped',
      reason: "ffmpeg could not encode the stream (exit 1): Unknown encoder 'libx265'",
    })
    expect(await readdir(path.join(dataDir, 'bench')).catch(() => [])).toEqual([])
  })

  it('a file without access-unit delimiters is refused', async () => {
    const dataDir = await tmp()
    const out = await ensureDecodeBenchSource(
      deps(dataDir, {
        runFfmpeg: async (_bin, args) => {
          await writeFile(args.at(-1) ?? '', Buffer.from([0, 0, 1, 0x65, 1, 2, 3]))
          return { code: 0, stderr: '' }
        },
      }),
      FHD,
    )
    expect(out.kind).toBe('skipped')
  })

  it('a node with no ffmpeg is a reason', async () => {
    const out = await ensureDecodeBenchSource(
      deps(await tmp(), {
        ensureFfmpeg: async () => {
          throw new Error('no ffmpeg build for this platform')
        },
      }),
      FHD,
    )
    expect(out).toEqual({
      kind: 'skipped',
      reason: 'no ffmpeg on this node: no ffmpeg build for this platform',
    })
  })
})
