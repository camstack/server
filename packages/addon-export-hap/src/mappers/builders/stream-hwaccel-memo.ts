/**
 * The two bounded memos HomeKit's decode path owns.
 *
 * ## Why they exist
 *
 * Everything D67 was actually about — one argv builder, one set of constants,
 * one hwaccel authority — HomeKit already had. What it did NOT have were the
 * two things the broker gained alongside them:
 *
 *  1. **A memo.** `probeDecoderHwaccel` issued a cross-process
 *     `decoder.getInfo` per SESSION. iOS starts sessions in bursts — one on
 *     record was started three times in 16 s — and every one of those paid a
 *     cap call on a hub whose main thread is the scarce resource.
 *  2. **Failure feedback.** When HomeKit's hardware child died at init and
 *     `shouldRetryInSoftware` saved the session, HomeKit told nobody. The next
 *     session re-picked the same corpse and paid the same two-second death.
 *     `EgressTranscodeManager` fixed exactly this for its own children
 *     (26a522cd5) by reporting the dead backend into the broker's 60 s memo.
 *
 * ## Both ride `HwAccelCache`, deliberately
 *
 * `createHwAccelCache` from `@camstack/types` is the primitive the broker's own
 * `egressHwAccelCache` is built from, and the discipline it encodes is the
 * point: **caller-owned, never a module global** — a module global would
 * outlive an addon respawn and survive an operator changing the decoder
 * backend. Same TTL as the broker's, so "has hardware come back yet" cannot
 * answer differently depending on which consumer asked.
 *
 * ## The cross-process gap, stated honestly
 *
 * These memos are scoped to the `export-hap` PROCESS. When HomeKit's vaapi
 * child dies, the broker's next child still pays its own two-second death, and
 * vice versa — because addons may never import each other and there is no
 * capability for "this backend is dead on this node right now". Closing that
 * would need a new cap surface, which Phase 0 explicitly does not take. What is
 * closed here is HomeKit's own repetition of the cost, across cameras and
 * across sessions.
 */
import { createHwAccelCache, type HwAccelCache, type HwAccelCacheOptions } from '@camstack/types'

import type { DecoderHwaccelReading } from './stream-hwaccel.js'

/**
 * The window both memos answer for.
 *
 * 60 s, the same as `stream-broker-manager`'s `egressHwAccelCache`. Long enough
 * that a burst of session restarts pays one read; short enough that an operator
 * who changes the decoder backend, or a host whose accelerator recovers, is
 * obeyed on the next session rather than after an addon respawn.
 */
export const HAP_DECODE_MEMO_TTL_MS = 60_000

/**
 * Separator inside the encoded reading. A control character, because a backend
 * name is `[a-z0-9]+` and the decoder's non-backend choices are `auto` /
 * `none` / `''`, none of which can contain one — so the split is total.
 */
const READING_SEPARATOR = '\u0001'

/**
 * Marks a `null` FIELD, distinct from an EMPTY one.
 *
 * `probedBestHwaccel: ''` means the decoder answered and has never probed
 * (=> `not-probed`); `null` means the field was absent altogether. Encoding
 * both as `''` would lose a distinction `selectHwDecode` acts on.
 */
const NULL_FIELD = '\u0000'

function encodeField(value: string | null): string {
  return value === null ? NULL_FIELD : value
}

function decodeField(value: string): string | null {
  return value === NULL_FIELD ? null : value
}

/**
 * A reading as ONE `string | null`, which is what {@link HwAccelCache} stores.
 *
 * The cache's three states are exactly the three a memoised reading needs:
 * `undefined` (never asked, or expired), `null` (asked, and the decoder could
 * not be reached), and a value. Encoding into the one cache rather than
 * splitting across two is what keeps those three from skewing — two caches
 * written together can still be READ across an expiry boundary.
 */
export function encodeDecoderReading(reading: DecoderHwaccelReading | null): string | null {
  if (reading === null) return null
  return `${encodeField(reading.hwaccel)}${READING_SEPARATOR}${encodeField(reading.probedBestHwaccel)}`
}

export function decodeDecoderReading(value: string | null): DecoderHwaccelReading | null {
  if (value === null) return null
  const [hwaccel = NULL_FIELD, probed = NULL_FIELD] = value.split(READING_SEPARATOR)
  return { hwaccel: decodeField(hwaccel), probedBestHwaccel: decodeField(probed) }
}

/**
 * The memoised `decoder.getInfo` answer for this node.
 *
 * `undefined` means "ask"; `null` means "we asked and nothing answered", which
 * is remembered on purpose — a node with no decoder addon bound is a legitimate
 * configuration and must not cost a failing cross-process call per session.
 */
export interface DecoderReadingMemo {
  read(): DecoderHwaccelReading | null | undefined
  write(reading: DecoderHwaccelReading | null): void
}

export function createDecoderReadingMemo(options: HwAccelCacheOptions): DecoderReadingMemo {
  const cache: HwAccelCache = createHwAccelCache(options)
  return {
    read(): DecoderHwaccelReading | null | undefined {
      const cached = cache.read()
      return cached === undefined ? undefined : decodeDecoderReading(cached)
    },
    write(reading: DecoderHwaccelReading | null): void {
      cache.write(encodeDecoderReading(reading))
    },
  }
}

/**
 * Everything HomeKit's decode path remembers between sessions.
 *
 * ONE instance per addon process, handed to every camera mapper. Per-camera
 * instances would mean camera B re-paying camera A's failed hardware init,
 * which is the repetition this closes.
 */
export interface HapDecodeMemos {
  readonly reading: DecoderReadingMemo
  /**
   * The backend that died at init in THIS process, if any is still inside the
   * window. Read as `read() ?? null` — an expired memo and "nothing failed"
   * mean the same thing to the selector.
   */
  readonly failedBackend: HwAccelCache
}

export function createHapDecodeMemos(now?: () => number): HapDecodeMemos {
  const options: HwAccelCacheOptions = { ttlMs: HAP_DECODE_MEMO_TTL_MS, ...(now ? { now } : {}) }
  return {
    reading: createDecoderReadingMemo(options),
    failedBackend: createHwAccelCache(options),
  }
}
