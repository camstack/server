/**
 * The on-disk brotli cache for SPA assets.
 *
 * The measurement that motivated it: the hub re-compressed the viewer's 6.7 MB
 * bundle on every uncached load — `time_starttransfer` 0.622 s with brotli
 * against 0.017 s without.
 *
 * The tests that matter are the ones about NOT serving the wrong bytes: a
 * stale sibling after a redeploy, and a read-only dist.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
import {
  acceptsBrotli,
  isCompressibleAsset,
  precompressedTempPath,
  resolvePrecompressedAsset,
  resetPrecompressedWarning,
  warmPrecompressedAssets,
} from '../precompressed-asset.js'

let dir: string

/** Compressible content large enough to clear the 1 KiB threshold. */
const BIG = 'export const x = 1;'.repeat(400)

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'precompressed-'))
  resetPrecompressedWarning()
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function writeAsset(name: string, body: string): Promise<string> {
  const p = path.join(dir, name)
  await fs.writeFile(p, body, 'utf-8')
  return p
}

describe('accept-encoding', () => {
  it('recognises brotli', () => {
    expect(acceptsBrotli('gzip, deflate, br, zstd')).toBe(true)
    expect(acceptsBrotli('br')).toBe(true)
  })

  it('does not mistake another token for it', () => {
    // `brotli` is not `br`, and a substring match would find it inside words.
    expect(acceptsBrotli('gzip, deflate')).toBe(false)
    expect(acceptsBrotli('gzipbr')).toBe(false)
    expect(acceptsBrotli(undefined)).toBe(false)
  })
})

describe('what is worth compressing', () => {
  it('takes text-shaped assets', () => {
    for (const f of ['a.js', 'a.mjs', 'a.css', 'index.html', 'x.json', 'i.svg', 'b.wasm']) {
      expect(isCompressibleAsset(f)).toBe(true)
    }
  })

  it('leaves already-compressed bytes alone', () => {
    // Running brotli over a JPEG burns CPU to make it marginally bigger.
    for (const f of ['a.jpg', 'a.png', 'a.woff2', 'a.mp4']) {
      expect(isCompressibleAsset(f)).toBe(false)
    }
  })
})

describe('resolvePrecompressedAsset', () => {
  it('compresses once and serves the sibling afterwards', async () => {
    const asset = await writeAsset('bundle.js', BIG)

    const first = await resolvePrecompressedAsset(asset, 'br')
    expect(first.encoding).toBe('br')
    expect(first.filePath).toBe(`${asset}.br`)

    // The bytes on disk really are the asset.
    const stored = await fs.readFile(first.filePath)
    expect(brotliDecompressSync(stored).toString()).toBe(BIG)
    expect(stored.byteLength).toBeLessThan(Buffer.byteLength(BIG) / 2)

    // Second call reuses it rather than recompressing — asserted by mtime,
    // which a fresh compression would move.
    const mtime = (await fs.stat(first.filePath)).mtimeMs
    const second = await resolvePrecompressedAsset(asset, 'br')
    expect(second.filePath).toBe(first.filePath)
    expect((await fs.stat(first.filePath)).mtimeMs).toBe(mtime)
  })

  it('REBUILDS a sibling older than its source', async () => {
    // A redeploy rewrites an asset in place under an unchanged name (the SPA
    // shell and the service worker both do). A stale sibling would serve the
    // previous build forever.
    const asset = await writeAsset('index.html', BIG)
    await resolvePrecompressedAsset(asset, 'br')

    await fs.writeFile(`${asset}.br`, 'stale', 'utf-8')
    const past = new Date(Date.now() - 60_000)
    await fs.utimes(`${asset}.br`, past, past)

    const resolved = await resolvePrecompressedAsset(asset, 'br')
    expect(brotliDecompressSync(await fs.readFile(resolved.filePath)).toString()).toBe(BIG)
  })

  it('collapses a concurrent burst into one compression', async () => {
    // Twelve parallel asset requests on a cold cache must not run twelve
    // brotli passes over the same megabytes.
    const asset = await writeAsset('shared.js', BIG)
    const results = await Promise.all(
      Array.from({ length: 12 }, () => resolvePrecompressedAsset(asset, 'br')),
    )
    expect(new Set(results.map((r) => r.filePath)).size).toBe(1)
    expect(results.every((r) => r.encoding === 'br')).toBe(true)
  })

  it('serves the original when the client does not accept brotli', async () => {
    const asset = await writeAsset('bundle.js', BIG)
    const resolved = await resolvePrecompressedAsset(asset, 'gzip')
    expect(resolved).toEqual({ filePath: asset, encoding: null })
  })

  it('serves the original for a tiny file', async () => {
    const asset = await writeAsset('tiny.js', 'x')
    expect((await resolvePrecompressedAsset(asset, 'br')).encoding).toBeNull()
  })

  it('serves the original when the dist cannot be written', async () => {
    // A dist the cache cannot be written into must degrade to exactly the
    // previous behaviour, never to a 500 or a truncated body.
    //
    // NOT `chmod 555` on the directory: that is a no-op for root, which is
    // what the CI runner is, and on 2026-09-23 this test produced a `.br` in
    // its "read-only" dist there. A directory sitting where the staged write
    // goes fails the write for every uid (EISDIR), and if the staging path
    // ever moves, the compression succeeds and this goes red rather than
    // silently green.
    const asset = await writeAsset('bundle.js', BIG)
    await fs.mkdir(precompressedTempPath(`${asset}.br`))
    const logged: string[] = []

    const resolved = await resolvePrecompressedAsset(asset, 'br', (msg) => logged.push(msg))
    expect(resolved).toEqual({ filePath: asset, encoding: null })
    // The failure is named — once per process, not per asset.
    expect(logged).toEqual(['cannot cache precompressed assets — serving compressed per request'])
    await resolvePrecompressedAsset(asset, 'br', (msg) => logged.push(msg))
    expect(logged).toHaveLength(1)
    // And nothing pretending to be the cache was left behind.
    await expect(fs.stat(`${asset}.br`)).rejects.toThrow()
  })

  it('serves the original for a file that is not there', async () => {
    const resolved = await resolvePrecompressedAsset(path.join(dir, 'ghost.js'), 'br')
    expect(resolved.encoding).toBeNull()
  })
})

describe('warmPrecompressedAssets', () => {
  it('compresses the whole dist so no client pays for the first request', async () => {
    // Measured live: the viewer's 5 MB bundle takes 6.7 s at quality 11 and
    // 14 ms afterwards. Without warming, one operator right after a deploy
    // waits those 6.7 s — WORSE than the 0.6 s the per-request compression
    // used to cost. This is the whole point of the function.
    await fs.mkdir(path.join(dir, '_expo', 'static'), { recursive: true })
    await writeAsset('index.html', BIG)
    await fs.writeFile(path.join(dir, '_expo', 'static', 'app.js'), BIG, 'utf-8')
    await fs.writeFile(path.join(dir, 'photo.jpg'), BIG, 'utf-8')

    warmPrecompressedAssets(dir)
    // Not awaited by design — poll for the effect rather than the call.
    for (let i = 0; i < 50; i += 1) {
      if (
        await fs.access(path.join(dir, '_expo', 'static', 'app.js.br')).then(
          () => true,
          () => false,
        )
      ) {
        break
      }
      await new Promise((r) => setTimeout(r, 20))
    }

    await expect(fs.access(path.join(dir, 'index.html.br'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(dir, '_expo', 'static', 'app.js.br'))).resolves.toBeUndefined()
    // An image is left alone — brotli over a JPEG burns CPU to grow it.
    await expect(fs.access(path.join(dir, 'photo.jpg.br'))).rejects.toThrow()
  })

  it('does not throw on a directory that is not there', () => {
    expect(() => warmPrecompressedAssets(path.join(dir, 'nope'))).not.toThrow()
  })
})
