import type { Range } from './types.js'

export function mergeRanges(
  segments: readonly { startMs: number; durMs: number }[],
  gapToleranceMs: number,
): Range[] {
  if (segments.length === 0) return []
  const sorted = [...segments].toSorted((a, b) => a.startMs - b.startMs)
  const out: Range[] = []
  let curStart = sorted[0]!.startMs
  let curEnd = sorted[0]!.startMs + sorted[0]!.durMs
  for (let i = 1; i < sorted.length; i++) {
    const s = sorted[i]!
    if (s.startMs <= curEnd + gapToleranceMs) {
      curEnd = Math.max(curEnd, s.startMs + s.durMs)
    } else {
      out.push({ startMs: curStart, endMs: curEnd })
      curStart = s.startMs
      curEnd = s.startMs + s.durMs
    }
  }
  out.push({ startMs: curStart, endMs: curEnd })
  return out
}
