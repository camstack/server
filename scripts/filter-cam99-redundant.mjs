#!/usr/bin/env node
// DRY-RUN: identify redundant (fully-overlapped) recording segments for cam99
// that are SAFE to remove — i.e. every instant they cover is also covered by at
// least one OTHER segment, so deleting them loses neither coverage nor seek
// targets. DELETES NOTHING. Writes the candidate file list per profile to /tmp.
import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DEVICE = 99
const PROFILES = ['mid', 'high', 'low']
const BASE = `server/backend/camstack-data/recordings/${DEVICE}`

function walk(dir) {
  let out = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out = out.concat(walk(p))
    else if (e.name.endsWith('.m4s')) {
      const [start, dur, bytes] = e.name
        .replace(/\.m4s$/, '')
        .split('-')
        .map(Number)
      out.push({ start, dur, bytes: bytes || 0, end: start + dur, path: p })
    }
  }
  return out
}

function analyze(profile) {
  const segs = walk(join(BASE, profile)).sort((a, b) => a.start - b.start || a.end - b.end)
  if (segs.length === 0) return null

  // Build a coverage-multiplicity step function via a boundary sweep.
  const evt = []
  for (const s of segs) {
    evt.push([s.start, 1], [s.end, -1])
  }
  evt.sort((a, b) => a[0] - b[0] || a[1] - b[1]) // at a tie, apply -1 before +1 (half-open [start,end))
  const pos = [],
    cnt = []
  let cur = 0
  for (let i = 0; i < evt.length; i++) {
    cur += evt[i][1]
    const at = evt[i][0]
    if (pos.length && pos[pos.length - 1] === at) cnt[cnt.length - 1] = cur
    else {
      pos.push(at)
      cnt.push(cur)
    }
  }
  // min multiplicity over [s,e): scan the step intervals overlapping [s,e)
  function minMult(s, e) {
    // binary search first boundary <= s
    let lo = 0,
      hi = pos.length - 1,
      idx = 0
    while (lo <= hi) {
      const m = (lo + hi) >> 1
      if (pos[m] <= s) {
        idx = m
        lo = m + 1
      } else hi = m - 1
    }
    let min = Infinity
    for (let i = idx; i < pos.length && pos[i] < e; i++) min = Math.min(min, cnt[i])
    return min === Infinity ? 0 : min
  }

  const removable = []
  let redundantBytes = 0
  for (const s of segs) {
    // Redundant iff every instant in [start,end) is covered by >=2 segments
    // (this one + at least one other) → removing it keeps full coverage.
    if (s.end > s.start && minMult(s.start, s.end) >= 2) {
      removable.push(s)
      redundantBytes += s.bytes
    }
  }
  const totalBytes = segs.reduce((a, s) => a + s.bytes, 0)
  return { profile, total: segs.length, removable, redundantBytes, totalBytes }
}

let grandRemovable = 0,
  grandBytes = 0
for (const profile of PROFILES) {
  const r = analyze(profile)
  if (!r) {
    console.log(`${profile}: (no segments)`)
    continue
  }
  console.log(
    `${profile.padEnd(4)} total=${String(r.total).padStart(6)}  removable=${String(r.removable.length).padStart(6)} (${((r.removable.length / r.total) * 100).toFixed(0)}%)  ` +
      `frees=${(r.redundantBytes / 1e9).toFixed(2)}GB of ${(r.totalBytes / 1e9).toFixed(2)}GB`,
  )
  const listPath = `/tmp/cam99-redundant-${profile}.txt`
  writeFileSync(
    listPath,
    r.removable.map((s) => s.path).join('\n') + (r.removable.length ? '\n' : ''),
  )
  grandRemovable += r.removable.length
  grandBytes += r.redundantBytes
}
console.log(`\nTOTAL removable=${grandRemovable} files, frees ~${(grandBytes / 1e9).toFixed(2)}GB`)
console.log('File lists written to /tmp/cam99-redundant-{mid,high,low}.txt — NOTHING deleted.')
