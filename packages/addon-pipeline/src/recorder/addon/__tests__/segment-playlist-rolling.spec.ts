/**
 * Replay of a REAL bounded playlist, captured from ffmpeg while it was running.
 *
 * `segment-watcher.spec.ts` tests the logic against windows that I wrote myself.
 * This file tests it against what ffmpeg REALLY WRITES with
 * `-segment_list_size`, because the question that matters is not "is my window
 * generator consistent" but "does the placeholder survive the real sliding of the
 * window, including the jump when two segments are born between two polls".
 *
 * PROVENANCE (not invented, not paraphrased): `live.m3u8` read every 2 s
 * during a `ffmpeg -f segment -segment_time 2 -segment_list_type m3u8
 * -segment_list_size 4` of 22 s, 2026-08-29, ffmpeg 7.1. The same
 * behaviour — bounded window + `#EXT-X-MEDIA-SEQUENCE` counting the
 * entries that left — was verified inside the hub image, ffmpeg
 * 6.1.1-3ubuntu5: 12 segments with `-segment_list_size 4` ⇒ 4 entries and
 * `#EXT-X-MEDIA-SEQUENCE:8`; the same run without the flag ⇒ 12 entries and `:0`.
 *
 * The invariant: **every segment delivered once and only once, in order, and
 * none skipped** — which is precisely what a placeholder kept as an
 * index into the body would lose.
 */
import { describe, it, expect } from 'vitest'
import { planFinalizations } from '../segment-watcher.js'

const head = (seq: number): readonly string[] => [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  `#EXT-X-MEDIA-SEQUENCE:${seq}`,
  '#EXT-X-ALLOW-CACHE:YES',
  '#EXT-X-TARGETDURATION:3',
]

const entries = (names: readonly number[], dur = '2.000000'): readonly string[] =>
  names.flatMap((n) => [`#EXTINF:${dur},`, `${n}.m4s`])

const snapshot = (seq: number, names: readonly number[], endlist = false): string =>
  [...head(seq), ...entries(names), ...(endlist ? ['#EXT-X-ENDLIST'] : [])].join('\n')

/** The ten polls at 2 s, verbatim in the structure read from disk. */
const POLLS: readonly string[] = [
  snapshot(0, [1788002343]),
  snapshot(0, [1788002343, 1788002347]),
  snapshot(0, [1788002343, 1788002347, 1788002349]),
  snapshot(0, [1788002343, 1788002347, 1788002349, 1788002351]),
  snapshot(1, [1788002347, 1788002349, 1788002351, 1788002353]),
  snapshot(2, [1788002349, 1788002351, 1788002353, 1788002355]),
  snapshot(3, [1788002351, 1788002353, 1788002355, 1788002357]),
  snapshot(4, [1788002353, 1788002355, 1788002357, 1788002359]),
  snapshot(5, [1788002355, 1788002357, 1788002359, 1788002361]),
  // The writer closes: two new segments between one poll and the next (sequence 5 → 7).
  snapshot(7, [1788002359, 1788002361, 1788002363, 1788002365], true),
]

/** All the files that run actually produced, from `ls` on the dir. */
const FILES_ON_DISK: readonly number[] = [
  1788002343, 1788002347, 1788002349, 1788002351, 1788002353, 1788002355, 1788002357, 1788002359,
  1788002361, 1788002363, 1788002365,
]

interface Replay {
  readonly handled: readonly string[]
  readonly rolledOff: number
}

/** The tick loop, reduced to what it decides: plans, delivers, advances. */
function replay(polls: readonly string[]): Replay {
  let processed = 0
  let rolledOff = 0
  const handled: string[] = []
  for (const body of polls) {
    const plan = planFinalizations(body, processed)
    rolledOff += plan.rolledOff
    for (const p of plan.toHandle) handled.push(p.entry.segPath)
    processed = plan.processed
  }
  return { handled, rolledOff }
}

describe('a real bounded playlist, re-read poll after poll', () => {
  const result = replay(POLLS)

  it('delivers every produced segment, exactly once and in order', () => {
    expect(result.handled).toEqual(FILES_ON_DISK.map((n) => `${n}.m4s`))
  })

  it('loses nothing along the way: no entry leaves the window unhandled', () => {
    expect(result.rolledOff).toBe(0)
  })

  it('survives the sequence jump when two segments are born between two polls', () => {
    // 5 → 7 in the last poll: if the jump were not read, 363 and 365 would be
    // delivered twice or never.
    const tail = result.handled.slice(-3)
    expect(tail).toEqual(['1788002361.m4s', '1788002363.m4s', '1788002365.m4s'])
  })

  it('re-reading the same poll redelivers nothing — the placeholder belongs to ffmpeg, not to the body', () => {
    const twice = replay([...POLLS, POLLS[POLLS.length - 1]!])
    expect(twice.handled).toEqual(result.handled)
  })
})
