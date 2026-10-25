#!/usr/bin/env node
// Headless emulation of the RecordedFeeder advance loop against REAL cam99
// segments on disk — no native demux, just the segment-selection logic that
// decides playback continuity. Detects backward cursor jumps (replays), false
// gaps, and overlap-induced judder.
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'server/backend/camstack-data/recordings/99/mid/2026/06/16'

// ── Load segments (start, dur) from filenames: {startMs}-{durMs}-{seq}.m4s ──
function walk(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.name.endsWith('.m4s')) {
      const [start, dur] = e.name
        .replace(/\.m4s$/, '')
        .split('-')
        .map(Number)
      out.push({ startMs: start, durMs: dur })
    }
  }
  return out
}
const segs = walk(ROOT).sort((a, b) => a.startMs - b.startMs)

// ── Replicate RecordingIndex.segmentAtIn (binary search: largest start<=epoch) ─
function segmentAt(epochMs) {
  let lo = 0,
    hi = segs.length - 1,
    cand = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (segs[mid].startMs <= epochMs) {
      cand = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  if (cand < 0) return null
  const s = segs[cand]
  return epochMs < s.startMs + s.durMs ? s : null
}
function nearestForward(epochMs) {
  const next = segs.find((s) => s.startMs >= epochMs)
  return next ? next.startMs : null
}
// True coverage check (ANY segment covers epoch) — to detect FALSE gaps.
function isCovered(epochMs) {
  return segs.some((s) => s.startMs <= epochMs && epochMs < s.startMs + s.durMs)
}

// ── Emulate the advance loop from a seek epoch ──
function simulate(seekEpoch, iterations, label) {
  console.log(
    `\n=== ${label}: seek ${seekEpoch} (${new Date(seekEpoch).toISOString().slice(11, 19)}) ===`,
  )
  let cursor = seekEpoch
  let backwardJumps = 0,
    replayMs = 0,
    falseGaps = 0,
    realGaps = 0,
    played = 0
  // initial seek: segmentAt(seek)
  let loc =
    segmentAt(seekEpoch) ??
    (() => {
      const e = nearestForward(seekEpoch)
      return e == null ? null : segmentAt(e)
    })()
  for (let i = 0; i < iterations; i++) {
    const probe = cursor + 1
    const seg = segmentAt(probe)
    if (seg === null) {
      // feeder would emit 'gap'; check whether coverage truly absent
      const coveredElsewhere = isCovered(probe)
      const edge = nearestForward(probe)
      if (coveredElsewhere) falseGaps++
      else realGaps++
      if (edge === null) {
        console.log(`  [${i}] ENDED at ${cursor}`)
        break
      }
      cursor = edge
      continue
    }
    // advance picks seg.startMs as the new cursor — detect backward move
    if (seg.startMs < cursor) {
      backwardJumps++
      replayMs += cursor - seg.startMs
    }
    played++
    cursor = seg.startMs + seg.durMs
  }
  console.log(
    `  played=${played} backwardJumps=${backwardJumps} replay=${(replayMs / 1000).toFixed(1)}s falseGaps=${falseGaps} realGaps=${realGaps}`,
  )
  return { backwardJumps, replayMs, falseGaps, realGaps }
}

// ── Proposed FORWARD-ONLY advance: cursor never moves backward, never replays ─
function simulateForwardOnly(seekEpoch, iterations, label) {
  let cursor = seekEpoch
  let backwardJumps = 0,
    replayMs = 0,
    realGaps = 0,
    played = 0,
    playedMs = 0
  // initial: if seek lands in a gap, snap forward
  if (!isCovered(cursor)) {
    const e = nearestForward(cursor)
    if (e == null) {
      console.log(`  FWD ${label}: no footage`)
      return
    }
    cursor = e
  }
  for (let i = 0; i < iterations; i++) {
    const seg = segmentAt(cursor)
    if (seg === null) {
      const edge = nearestForward(cursor)
      realGaps++
      if (edge === null) break
      cursor = edge
      continue
    }
    const end = seg.startMs + seg.durMs
    // play only [cursor, end): the already-seen [seg.start, cursor) is skipped
    playedMs += end - cursor
    if (end <= cursor) backwardJumps++ // must never happen
    played++
    cursor = end // strictly forward
  }
  console.log(
    `  FWD ${label}: played=${played} (${(playedMs / 1000).toFixed(1)}s) backwardJumps=${backwardJumps} replay=${(replayMs / 1000).toFixed(1)}s realGaps=${realGaps}`,
  )
}

// ── REALIZABLE forward-only for GOP video: skip segments STARTING before the
//    frontier (can't start mid-GOP), play whole segments that start >= frontier.
function simulateRealizable(seekEpoch, iterations, label) {
  let cursor = seekEpoch
  let played = 0,
    playedMs = 0,
    contentSkipMs = 0,
    realGaps = 0,
    replay = 0
  if (!isCovered(cursor)) {
    const e = nearestForward(cursor)
    if (e == null) return
    cursor = e
  }
  for (let i = 0; i < iterations; i++) {
    let next = segmentAt(cursor + 1)
    let guard = 0
    while (next && next.startMs < cursor && guard++ < 100) {
      next = segmentAt(next.startMs + next.durMs + 1)
    }
    if (!next) {
      const edge = nearestForward(cursor)
      realGaps++
      if (edge === null) break
      cursor = edge
      continue
    }
    if (next.startMs < cursor) replay++ // must be 0
    if (next.startMs > cursor) contentSkipMs += next.startMs - cursor
    played++
    playedMs += next.durMs
    cursor = next.startMs + next.durMs
  }
  console.log(
    `  REALIZABLE ${label}: played=${played} (${(playedMs / 1000).toFixed(1)}s) replay=${replay} contentSkipped=${(contentSkipMs / 1000).toFixed(1)}s realGaps=${realGaps}`,
  )
}

console.log(`loaded ${segs.length} mid segments`)
// Corrupted (deploy-churn) window vs clean (recent) window.
simulate(1781631893000, 60, 'CURRENT advance — CORRUPTED window')
simulateRealizable(1781631893000, 60, 'CORRUPTED window')
simulate(1781646440000, 60, 'CURRENT advance — CLEAN window')
simulateRealizable(1781646440000, 60, 'CLEAN window')
