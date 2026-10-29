/**
 * `RssAnon` of this process — the part of the footprint a GC or `malloc_trim`
 * can hand back. Kept out of `heap-watch.ts` on purpose: that module is
 * asserted to touch no filesystem itself (the heartbeat probe is not a place to
 * grow a `/proc` census); this is the one small read it is handed.
 */
import { readFileSync } from 'node:fs'
import { parseProcStatusRss } from '../process/proc-stat.js'

/**
 * `RssAnon` in bytes, from the text of `/proc/self/status`.
 * `undefined` when the field is absent — an unmeasured number is not zero.
 */
export function parseAnonRssBytes(status: string): number | undefined {
  return parseProcStatusRss(status).privateBytes
}

/**
 * The default `RssAnon` reader: Linux only. macOS and Windows have no such
 * split, so they keep `rss`. A failed read returns `undefined` (the caller
 * falls back to `rss`) and is logged ONCE — a silent fallback would look like
 * the honest number (D391).
 */
export function createAnonRssReader(
  warn: (line: string) => void,
  platform: NodeJS.Platform = process.platform,
  readStatus: () => string = (): string => readFileSync('/proc/self/status', 'utf8'),
): () => number | undefined {
  if (platform !== 'linux') return () => undefined
  let warned = false
  return () => {
    try {
      const anon = parseAnonRssBytes(readStatus())
      if (anon !== undefined) return anon
      throw new Error('RssAnon missing from /proc/self/status')
    } catch (error) {
      if (!warned) {
        warned = true
        warn(
          `[mem] RssAnon unreadable (${error instanceof Error ? error.message : String(error)}) — ` +
            `the reclaim gate falls back to VmRSS, which counts file-backed pages`,
        )
      }
      return undefined
    }
  }
}
