/**
 * Brotli-compressed copies of static SPA assets, cached on disk.
 *
 * The hub re-compressed the viewer's 6.7 MB bundle from disk on EVERY uncached
 * load: measured `time_starttransfer` 0.622 s with brotli against 0.017 s
 * without. That is 0.6 s of hub CPU before the first byte, paid again by every
 * client, for a file whose content is content-hashed and therefore never
 * changes.
 *
 * Populated lazily on the first request rather than at build time, and that is
 * the important choice. The two SPAs reach this hub down DIFFERENT ship chains
 * — the admin-ui through a deployed addon dist, the viewer through its own
 * export — and a build step wired into one of them silently stops covering the
 * other. A cache built from whatever is on disk cannot fall behind either.
 *
 * The first request for a given file still pays the compression, exactly as
 * every request does today. Every request after it pays nothing.
 */

import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { brotliCompress, constants as zlibConstants } from 'node:zlib'
import { promisify } from 'node:util'

const brotli = promisify(brotliCompress)

/** Below this, the framing costs more than the compression saves — the same
 *  threshold `@fastify/compress` is registered with. */
const MIN_BYTES = 1024

/** Types worth compressing. Images and fonts are already compressed; running
 *  brotli over a JPEG burns CPU to make it marginally bigger. */
const COMPRESSIBLE = /\.(js|mjs|cjs|css|html|json|svg|map|txt|webmanifest|wasm)$/i

/** One in-flight compression per path, so a cold cache hit by twelve parallel
 *  asset requests compresses once instead of twelve times. */
const inFlight = new Map<string, Promise<string | null>>()

/** Logged once per process — a read-only dist is a deployment fact, not an
 *  error to repeat on every asset. */
let warnedUnwritable = false

export interface PrecompressedAsset {
  /** Absolute path of the file to send. */
  readonly filePath: string
  /** Value for `content-encoding`, or null to send the original as-is. */
  readonly encoding: 'br' | null
}

/** Does the client accept brotli? */
export function acceptsBrotli(acceptEncoding: string | undefined): boolean {
  if (acceptEncoding === undefined) return false
  return /\bbr\b/.test(acceptEncoding)
}

export function isCompressibleAsset(relOrAbs: string): boolean {
  return COMPRESSIBLE.test(relOrAbs)
}

/**
 * A `.br` sibling is only valid while it is NEWER than its source.
 *
 * A redeploy rewrites an asset in place under an unchanged name (the SPA shell
 * and the service worker both do), and a stale sibling would serve the previous
 * build forever — the exact failure mode of every cache that skips this check.
 */
async function freshSibling(filePath: string, brPath: string): Promise<boolean> {
  try {
    const [src, br] = await Promise.all([fsp.stat(filePath), fsp.stat(brPath)])
    return br.mtimeMs >= src.mtimeMs && br.size > 0
  } catch {
    return false
  }
}

async function compressToDisk(
  filePath: string,
  brPath: string,
  log?: (msg: string, meta: Record<string, unknown>) => void,
): Promise<string | null> {
  try {
    const raw = await fsp.readFile(filePath)
    const out = await brotli(raw, {
      params: {
        // Quality 11 is worth it BECAUSE this runs once. The per-request path
        // could never afford it, which is why it was set to 4.
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.byteLength,
      },
    })
    // Write via a temp file + rename so a concurrent reader never sees a
    // half-written body.
    const tmp = precompressedTempPath(brPath)
    await fsp.writeFile(tmp, out)
    await fsp.rename(tmp, brPath)
    log?.('precompressed a static asset', {
      file: path.basename(filePath),
      rawBytes: raw.byteLength,
      brBytes: out.byteLength,
    })
    return brPath
  } catch (err) {
    if (!warnedUnwritable) {
      warnedUnwritable = true
      log?.('cannot cache precompressed assets — serving compressed per request', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return null
  }
}

/**
 * Resolve what to actually send for one static asset.
 *
 * Returns the original with `encoding: null` whenever anything is off — the
 * client does not accept brotli, the file is not worth compressing, or the
 * cache could not be written. The caller then serves exactly what it served
 * before, so this can only ever be an optimisation.
 */
export async function resolvePrecompressedAsset(
  filePath: string,
  acceptEncoding: string | undefined,
  log?: (msg: string, meta: Record<string, unknown>) => void,
): Promise<PrecompressedAsset> {
  const plain: PrecompressedAsset = { filePath, encoding: null }
  if (!acceptsBrotli(acceptEncoding) || !isCompressibleAsset(filePath)) return plain

  let size = 0
  try {
    size = (await fsp.stat(filePath)).size
  } catch {
    return plain
  }
  if (size < MIN_BYTES) return plain

  const brPath = `${filePath}.br`
  if (await freshSibling(filePath, brPath)) return { filePath: brPath, encoding: 'br' }

  const pending = inFlight.get(filePath) ?? compressToDisk(filePath, brPath, log)
  inFlight.set(filePath, pending)
  try {
    const produced = await pending
    return produced === null ? plain : { filePath: produced, encoding: 'br' }
  } finally {
    inFlight.delete(filePath)
  }
}

/**
 * Compress a dist's assets in the background, so no CLIENT pays for the first
 * one.
 *
 * Measured on the live hub: the viewer's 5 MB bundle takes 6.7 s at quality 11.
 * Every request after it is served in 14 ms — but without this, one unlucky
 * operator right after a deploy waits those 6.7 s, which is WORSE than the
 * 0.6 s the per-request compression used to cost. Warming turns a cliff into a
 * bit of boot-time CPU nobody is waiting on.
 *
 * Deliberately not awaited by the caller, and deliberately serial: this runs
 * while the hub is booting the rest of itself, and saturating the CPU to make
 * a page load faster would be a bad trade. Failures are silent here — the
 * request path logs them if it ever hits one.
 */
export function warmPrecompressedAssets(
  root: string,
  log?: (msg: string, meta: Record<string, unknown>) => void,
): void {
  void (async () => {
    let warmed = 0
    for (const file of await listCompressible(root)) {
      const resolved = await resolvePrecompressedAsset(file, 'br').catch(() => null)
      if (resolved?.encoding === 'br') warmed += 1
    }
    if (warmed > 0) log?.('warmed the precompressed asset cache', { root, files: warmed })
  })()
}

async function listCompressible(dir: string, out: string[] = []): Promise<string[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await listCompressible(full, out)
    else if (isCompressibleAsset(entry.name) && !entry.name.endsWith('.br')) out.push(full)
  }
  return out
}

/** Test seam — the "read-only dist" warning is once per process. */
export function resetPrecompressedWarning(): void {
  warnedUnwritable = false
}

/**
 * Where a compression is staged before the rename. Exported so the test can
 * make THIS write fail for any uid: a `chmod 555` on the dist does nothing to
 * root, which is what CI runs as, and the test that relied on it produced a
 * `.br` in a "read-only" directory (2026-09-23).
 */
export function precompressedTempPath(brPath: string): string {
  return `${brPath}.${String(process.pid)}.tmp`
}

/** Synchronous existence probe used by the callers' own guards. */
export function precompressedSiblingExists(filePath: string): boolean {
  return fs.existsSync(`${filePath}.br`)
}
