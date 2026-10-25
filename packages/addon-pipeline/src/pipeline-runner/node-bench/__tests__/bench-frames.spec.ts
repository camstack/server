/**
 * D791 — the bench clip is used ONLY when its bytes are the pinned revision;
 * anything else (not published, a bad download) falls back to the node's
 * reference images, and the frame set says which it is.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  BENCH_CLIP,
  type BenchFrameDeps,
  ensureBenchClip,
  loadBenchFrames,
} from '../bench-frames.js'

function deps(over: Partial<BenchFrameDeps> = {}): BenchFrameDeps {
  return {
    dataDir: mkdtempSync(path.join(tmpdir(), 'bench-frames-')),
    ensureFfmpeg: async () => 'ffmpeg',
    fetch: vi.fn(async () => new Response('nope', { status: 404 })) as unknown as typeof fetch,
    referenceImages: async () => [new Uint8Array([1]), new Uint8Array([2])],
    decodeJpeg: async (jpeg) => ({ data: jpeg, width: 2, height: 1 }),
    log: () => undefined,
    ...over,
  }
}

describe('loadBenchFrames', () => {
  it('an unpublished clip (no pinned hash) measures on the reference images and says so', async () => {
    const d = deps({ clip: { ...BENCH_CLIP, sha256: null } })
    const set = await loadBenchFrames(d)
    expect(set.clip.id).toBe('reference-images')
    expect(set.frames).toHaveLength(2)
    expect(d.fetch).not.toHaveBeenCalled()
  })

  it('a download whose bytes are not the pinned revision is refused and removed', async () => {
    const d = deps({
      clip: { ...BENCH_CLIP, sha256: 'a'.repeat(64) },
      fetch: vi.fn(async () => new Response('tampered')) as unknown as typeof fetch,
    })
    await expect(ensureBenchClip(d)).rejects.toThrow(/sha256/)
    const set = await loadBenchFrames(d)
    expect(set.clip.id).toBe('reference-images')
  })

  it('a verified clip already on disk is reused without a download', async () => {
    const d = deps()
    const bytes = Buffer.from('clip-bytes')
    const sha = createHash('sha256').update(bytes).digest('hex')
    const dir = path.join(d.dataDir, 'bench')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, BENCH_CLIP.fileName), bytes)
    const file = await ensureBenchClip({ ...d, clip: { ...BENCH_CLIP, sha256: sha } })
    expect(file).toBe(path.join(dir, BENCH_CLIP.fileName))
    expect(d.fetch).not.toHaveBeenCalled()
  })

  it('no frame at all is an error, never an empty run', async () => {
    await expect(
      loadBenchFrames(
        deps({ clip: { ...BENCH_CLIP, sha256: null }, referenceImages: async () => [] }),
      ),
    ).rejects.toThrow(/reference image/)
  })
})
