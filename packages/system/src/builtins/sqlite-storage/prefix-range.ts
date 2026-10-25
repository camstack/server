/**
 * Turn a key PREFIX into a half-open range SQLite can answer from the index.
 *
 * **The measurement.** The two canonical KV tables (`addon-settings`,
 * `addon-device-settings`) are keyed `"<scope>.<key>"` and every scoped read
 * and write selects by prefix. That was written as `WHERE id LIKE ? || '%'`,
 * and SQLite cannot use an index for it: `LIKE` is case-insensitive for ASCII
 * by default, so the LIKE optimisation requires an index with `COLLATE
 * NOCASE`, which the implicit PRIMARY KEY index is not. `EXPLAIN QUERY PLAN`
 * says so in one word:
 *
 *     LIKE   =>  SCAN addon-device-settings
 *     RANGE  =>  SEARCH addon-device-settings USING INDEX … (id>? AND id<?)
 *
 * Every `writeDeviceRuntimeState` therefore scanned the whole table before
 * inserting, on the main thread, synchronously — 15.6% of hub-main's CPU in
 * the 2026-08-07 V8 profile sat in this transaction. Measured on a 2 240-row
 * table (far smaller than the live one, and the gap widens linearly with rows):
 *
 *     write  (1 DELETE + 14 UPSERT, one txn)   0.253 ms → 0.143 ms   1.8x
 *     read   (getAllScoped)                    0.207 ms → 0.011 ms  19.4x
 *
 * **It is also more CORRECT, which was not the goal.** `LIKE` treats `_` and
 * `%` in the PATTERN as wildcards, and the pattern here is built from an addon
 * id and a device id. `clearAddonDevice('a_b', …)` deleted `axb`'s rows too,
 * and `LIKE`'s ASCII case-folding meant `Recorder:101.` matched
 * `recorder:101.`. A byte range matches exactly the keys that start with the
 * prefix and nothing else.
 *
 * **Why it can refuse.** SQLite's BINARY collation compares UTF-8 BYTES; JS
 * compares UTF-16 code units. The two orders agree for ASCII and can disagree
 * above it. Rather than encode a subtle equivalence nobody will re-derive, a
 * non-ASCII prefix returns `null` and the caller keeps the existing `LIKE` —
 * slower, but identical to what shipped. Every prefix in this codebase is an
 * addon id, a device id and separators, so the fast path is the only one that
 * runs in practice; the fallback exists so a future key shape cannot silently
 * lose rows.
 */

/** Half-open key range `[lo, hi)` covering exactly the keys starting with a prefix. */
export interface PrefixRange {
  readonly lo: string
  /** EXCLUSIVE upper bound: the prefix with its last byte incremented. */
  readonly hi: string
}

const MAX_ASCII = 0x7f

/**
 * @returns the range for `prefix`, or `null` when the caller must fall back to
 *   a `LIKE` scan (empty prefix — which is the whole table and has no upper
 *   bound — or any byte outside ASCII).
 */
export function prefixRange(prefix: string): PrefixRange | null {
  if (prefix.length === 0) return null
  for (let i = 0; i < prefix.length; i++) {
    const code = prefix.charCodeAt(i)
    // 0 would make `lo` unrepresentable as a C string param; >0x7f leaves
    // UTF-8 byte order and UTF-16 code-unit order free to disagree.
    if (code === 0 || code > MAX_ASCII) return null
  }
  const last = prefix.charCodeAt(prefix.length - 1)
  // A prefix ending at the top of ASCII has no ASCII successor. Never happens
  // for `.`/`:`-terminated keys, but "never happens" is how a wrong bound
  // ships: refuse instead of wrapping to 0x80.
  if (last >= MAX_ASCII) return null
  return {
    lo: prefix,
    hi: prefix.slice(0, -1) + String.fromCharCode(last + 1),
  }
}
