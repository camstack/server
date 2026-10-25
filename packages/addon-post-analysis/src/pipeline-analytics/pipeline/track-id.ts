/**
 * A track's identity: short, random, and mintable inside a frame.
 *
 * ## Why not a counter, and why not the database
 *
 * The operator asked for an incremental id. It cannot be a database
 * auto-increment: the id is minted by the tracker MID-FRAME and is used
 * immediately — in the event, in the media key, as the `object-clip` vector's
 * row id — long before anything is written, so there is no rowid to wait for
 * and no await to spend on the hot path (D49: a one-shot never gates on a
 * fallible read).
 *
 * A local counter was already tried and reverted. The old tracker's own
 * record of it (`sort-tracker.ts`, deleted with it — D683 Task 21): "A bare
 * per-process counter (`track-${n++}`) reset to 1 on every runner restart and
 * collided across restarts AND devices — a post-reboot track reused an old id
 * and UPSERT-clobbered the old persisted row (wrong 'now' dates, stale
 * bestEventId thumbnails, cross-session media in the detail view)."
 *
 * A durable counter is possible — the hub hands each node a BLOCK of ids ahead
 * of need, and the bookmark advances before they are used, so a crash leaves a
 * gap and never a duplicate. It was designed and NOT built: agents hold no
 * sqlite of their own (the hub is the only store), so the whole mechanism is a
 * cluster allocator with a degrade path, for a property nobody reads. The
 * operator chose the smaller thing.
 *
 * So: still random, and only shorter. 36 characters become 10.
 *
 * ## Is 10 enough
 *
 * Arithmetic, not optimism. The alphabet is 32 characters, so an id is 50 bits
 * and the space is 32^10 ≈ 1.13e15. The live table held 17 870 track rows under
 * a 7-day window (measured, `database-reduction-plan`), so call the population
 * 20 000 ids that must not collide with each other. Birthday:
 *
 *     p ≈ n² / 2N = 4e8 / 2.25e15 ≈ 1.8e-7 per retention window
 *
 * ~1e-5 per year at the current fleet. A collision is not cosmetic — two tracks
 * sharing an id UPSERT over each other, which is precisely the old counter's
 * failure — so the margin is deliberately three orders of magnitude wider than
 * "probably fine", and it is the reason this is 10 characters and not 6.
 *
 * ## The alphabet
 *
 * Crockford-style base32, lower case: the digits plus the letters, minus
 * `i`, `l`, `o` and `u`. The first three are misread as `1`/`1`/`0` by a human
 * copying an id out of a log; `u` goes with them so the set is exactly 32,
 * which is what lets five raw bits map to one character with NO modulo bias.
 * A `% 36` over a byte would make the first 16 characters ~1.5× more likely and
 * silently shrink the space the arithmetic above depends on.
 */
import { randomBytes } from 'node:crypto'

/** 32 characters: `0-9a-z` minus `i`, `l`, `o`, `u`. A power of two, on purpose. */
export const TRACK_ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

/** 50 bits. See the collision arithmetic above before shortening this. */
export const TRACK_ID_LENGTH = 10

/**
 * A fresh track id. Synchronous, no I/O, no shared state — safe to call from
 * inside the tracker's per-frame loop, which is the only place that calls it.
 */
export function newTrackId(): string {
  const bytes = randomBytes(TRACK_ID_LENGTH)
  let out = ''
  for (let i = 0; i < TRACK_ID_LENGTH; i += 1) {
    // Five bits per character: the alphabet is 32 long, so the mask is exact
    // and every character is equally likely.
    out += TRACK_ID_ALPHABET[(bytes[i] ?? 0) & 31]
  }
  return out
}

/**
 * Who mints a track id. Production: {@link newTrackId}. The tracking bench
 * injects a deterministic one so a replay is byte-reproducible (D681) — the
 * id is the tracker's ONLY non-deterministic input.
 */
export type TrackIdMinter = () => string

/** `t1`, `t2`, … in spawn order. The bench's minter; never used in production. */
export function sequentialTrackIdMinter(prefix = 't'): TrackIdMinter {
  let n = 0
  return (): string => {
    n += 1
    return `${prefix}${String(n)}`
  }
}
