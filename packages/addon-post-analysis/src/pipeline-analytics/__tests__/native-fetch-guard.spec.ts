import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * S4 grep-guard (refactor spec `2026-07-22-post-analysis-maintainability-
 * refactor-design.md`, A7 acceptance): capture pressure is ONE number in ONE
 * file. Every native-fetch closure invocation must run inside a
 * `CaptureScheduler` exec — either the call site passes its work to
 * `captureScheduler.request({ exec })` directly, or it lives inside a batch
 * that is itself dispatched as one scheduler request.
 *
 * This spec walks the package's `src` tree and asserts that NO file invokes
 * the raw native-fetch closures (`getNativeCropJpeg(` / `getNativeFullFrameRgb(` / `getNativeFullFrameJpeg(`)
 * outside the allow-list below. The allow-list is
 * COUNT-exact: adding a new direct invocation to an allow-listed file trips
 * the guard just like adding one to a new file, and removing one forces the
 * allow-list (and its justification) to be updated.
 *
 * Notes on what the pattern deliberately does NOT match:
 *  - definitions (`const getNativeCropJpeg = async (`) and type/interface
 *    members (`readonly getNativeCropJpeg?: (`) — only bare `name(` invocation
 *    shapes count;
 *  - the closure internals in `runtime/native-frame-transport.ts`
 *    (`fetchNativeCropJpeg`, `fetchNativeFullFrameTiered`, `getRemoteFrame`)
 *    — those are the BODIES the scheduler executors run, not additional call
 *    sites.
 */

/** Invocation shape of the three raw native-fetch closures. */
const RAW_FETCH_CALL = /(?:getNativeCropJpeg|getNativeFullFrameRgb|getNativeFullFrameJpeg)\s*\(/g

interface AllowedRawFetchFile {
  /** Path relative to the package `src/` root (posix separators). */
  readonly file: string
  /** EXACT number of direct invocations allowed in that file. */
  readonly count: number
  /** Why these invocations are exempt from direct scheduler routing. */
  readonly reason: string
}

/**
 * THE allow-list. Keep it tiny and keep every entry justified — a new entry
 * needs the same scrutiny as a new uncoordinated capture cadence (the exact
 * bug class S3/S4 exist to kill).
 */
const ALLOWED_RAW_FETCH_FILES: readonly AllowedRawFetchFile[] = [
  {
    file: 'pipeline-analytics/services/event-media-dispatcher.ts',
    count: 3,
    reason:
      'display child crops (cropSubjectRegion) and boxed timeline tiles run ' +
      'INSIDE captureForFrame, which index.ts dispatches ' +
      'as ONE CaptureScheduler request (S3) — the batch already holds the budget ' +
      'slot; wrapping the inner fetches would double-count it and could deadlock ' +
      'the lane against its own batch.',
  },
]

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Recursively collect production .ts sources (skip tests and declarations). */
function collectSourceFiles(dir: string): readonly string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full))
      continue
    }
    if (!entry.name.endsWith('.ts')) continue
    if (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.test.ts')) continue
    if (entry.name.endsWith('.d.ts')) continue
    out.push(full)
  }
  return out
}

function countRawFetchCalls(filePath: string): number {
  const source = readFileSync(filePath, 'utf8')
  return [...source.matchAll(RAW_FETCH_CALL)].length
}

describe('S4 native-fetch grep-guard — all capture pressure is scheduler-owned', () => {
  const files = collectSourceFiles(SRC_ROOT)
  const countsByFile = new Map<string, number>(
    files.map((f) => [path.relative(SRC_ROOT, f).split(path.sep).join('/'), countRawFetchCalls(f)]),
  )

  it('scans a plausible tree (sanity: the known call sites are visible)', () => {
    // Guard the guard: if the walk or pattern silently broke, this spec would
    // vacuously pass. The dispatcher's two batch-internal calls must be seen
    // (the best-shot thumbnail left this list with D422: it reads a parked
    // parcel by track, not a native fetch by handle).
    expect(countsByFile.get('pipeline-analytics/services/event-media-dispatcher.ts')).toBe(3)
    expect(files.length).toBeGreaterThan(50)
  })

  it('no file outside the allow-list directly invokes a raw native-fetch closure', () => {
    const allowed = new Map(ALLOWED_RAW_FETCH_FILES.map((a) => [a.file, a.count]))
    const violations: string[] = []
    for (const [file, count] of countsByFile) {
      if (count === 0) continue
      if (allowed.get(file) === undefined) {
        violations.push(
          `${file}: ${count} direct native-fetch invocation(s) — route them through ` +
            `captureScheduler.request (see runtime/capture-scheduler.ts) or justify an allow-list entry`,
        )
      }
    }
    expect(violations).toEqual([])
  })

  it('allow-listed files keep their EXACT invocation count (drift trips the guard)', () => {
    for (const entry of ALLOWED_RAW_FETCH_FILES) {
      const actual = countsByFile.get(entry.file)
      expect(
        actual,
        `${entry.file}: expected exactly ${entry.count} allowed invocation(s) (${entry.reason})`,
      ).toBe(entry.count)
    }
  })
})
