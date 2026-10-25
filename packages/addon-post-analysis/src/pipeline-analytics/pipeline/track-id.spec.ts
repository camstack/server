/**
 * The short track id.
 *
 * A UUID is 36 characters and appears in every media key, every vector row id,
 * every URL and every log line about a track. The operator asked for something
 * readable. What it may NOT become is the thing that was already tried and
 * reverted — the old tracker's own record of it (`sort-tracker.ts`, deleted
 * with it — D683 Task 21): "A bare per-process counter (`track-${n++}`) reset
 * to 1 on every runner restart and collided across restarts AND devices — a
 * post-reboot track reused an old id and UPSERT-clobbered the old persisted
 * row."
 *
 * So it stays RANDOM (no state to reset, nothing to allocate, mintable inside a
 * frame with no I/O) and only gets shorter.
 */
import { describe, expect, it } from 'vitest'
import { newTrackId, TRACK_ID_ALPHABET, TRACK_ID_LENGTH } from './track-id.js'

describe('newTrackId', () => {
  it('is short and uses only the declared alphabet', () => {
    for (let i = 0; i < 200; i += 1) {
      const id = newTrackId()
      expect(id).toHaveLength(TRACK_ID_LENGTH)
      for (const ch of id) expect(TRACK_ID_ALPHABET).toContain(ch)
    }
  })

  it('never produces a character that can be misread', () => {
    // `i`/`l`/`1`, `o`/`0`, `u`/`v`: an operator reads these out of a log and
    // types them into a search box. The alphabet excludes the ambiguous half
    // rather than relying on nobody making the mistake.
    expect(TRACK_ID_ALPHABET).not.toContain('i')
    expect(TRACK_ID_ALPHABET).not.toContain('l')
    expect(TRACK_ID_ALPHABET).not.toContain('o')
    expect(TRACK_ID_ALPHABET).not.toContain('u')
  })

  it('cannot be confused with the one prefix this system DOES parse', () => {
    // `occupancy-watcher` asks `trackId.startsWith('stationary:')`. An id that
    // could start that way would be silently treated as a stationary track.
    for (let i = 0; i < 500; i += 1) {
      expect(newTrackId().startsWith('stationary:')).toBe(false)
    }
  })

  it('does not repeat itself across many draws', () => {
    // Not proof of the collision bound — that is arithmetic, in the module —
    // but it catches the failure that actually happens: a generator wired to a
    // seeded or per-process source that returns the same value twice.
    const seen = new Set<string>()
    for (let i = 0; i < 20_000; i += 1) seen.add(newTrackId())
    expect(seen.size).toBe(20_000)
  })

  it('is drawn without modulo bias', () => {
    // The alphabet is a power of two so 5 raw bits map to exactly one character.
    // A `% alphabet.length` over a byte would make the first 16 characters ~1.5x
    // more likely and quietly shrink the real id space.
    expect(TRACK_ID_ALPHABET.length & (TRACK_ID_ALPHABET.length - 1)).toBe(0)
    const counts = new Map<string, number>()
    for (let i = 0; i < 4_000; i += 1) {
      for (const ch of newTrackId()) counts.set(ch, (counts.get(ch) ?? 0) + 1)
    }
    expect(counts.size).toBe(TRACK_ID_ALPHABET.length)
    const expected = (4_000 * TRACK_ID_LENGTH) / TRACK_ID_ALPHABET.length
    for (const [ch, n] of counts) {
      expect(Math.abs(n - expected) / expected, ch).toBeLessThan(0.25)
    }
  })
})
