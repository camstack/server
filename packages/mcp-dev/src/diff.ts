/** A small unified diff for scaffold dry runs (plan §3.10: "writes are dry-run first and show a diff"). */

const CONTEXT = 2

export function unifiedDiff(file: string, before: string | null, after: string): string {
  const a = before === null ? [] : before.split('\n')
  const b = after.split('\n')
  const header = [`--- ${before === null ? '/dev/null' : `a/${file}`}`, `+++ b/${file}`]
  if (before === null) {
    return [...header, `@@ -0,0 +1,${b.length} @@`, ...b.map((l) => `+${l}`)].join('\n')
  }
  const ops = diffLines(a, b)
  const hunks = toHunks(ops)
  return hunks.length === 0 ? '' : [...header, ...hunks].join('\n')
}

type Op = { readonly t: ' ' | '+' | '-'; readonly line: string }

function diffLines(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from({ length: m + 1 }, () => 0),
  )
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: ' ', line: a[i]! })
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ t: '-', line: a[i++]! })
    } else {
      ops.push({ t: '+', line: b[j++]! })
    }
  }
  while (i < n) ops.push({ t: '-', line: a[i++]! })
  while (j < m) ops.push({ t: '+', line: b[j++]! })
  return ops
}

function toHunks(ops: readonly Op[]): string[] {
  const changed = ops.map((o, idx) => (o.t === ' ' ? -1 : idx)).filter((idx) => idx >= 0)
  if (changed.length === 0) return []
  const out: string[] = []
  let start = Math.max(0, changed[0]! - CONTEXT)
  let end = Math.min(ops.length, changed[0]! + CONTEXT + 1)
  const flush = (s: number, e: number): void => {
    const slice = ops.slice(s, e)
    const oldStart = ops.slice(0, s).filter((o) => o.t !== '+').length + 1
    const newStart = ops.slice(0, s).filter((o) => o.t !== '-').length + 1
    const oldLen = slice.filter((o) => o.t !== '+').length
    const newLen = slice.filter((o) => o.t !== '-').length
    out.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`)
    out.push(...slice.map((o) => `${o.t}${o.line}`))
  }
  for (const idx of changed.slice(1)) {
    if (idx - CONTEXT <= end) {
      end = Math.min(ops.length, idx + CONTEXT + 1)
    } else {
      flush(start, end)
      start = Math.max(0, idx - CONTEXT)
      end = Math.min(ops.length, idx + CONTEXT + 1)
    }
  }
  flush(start, end)
  return out
}
