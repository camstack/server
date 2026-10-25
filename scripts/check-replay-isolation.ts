#!/usr/bin/env tsx
/**
 * Replay isolation guard — a replay run is a dry-run, and the ONLY thing that
 * makes that true is that nothing under a `replay/` directory can reach a
 * production writer.
 *
 * ## Why this exists
 *
 * `docs/design/plans/2026-08-26-clip-replay-on-pipeline.md` — replaying a
 * REAL pipeline over a fixed clip, without writing to the production
 * collections. The FrameProcessor pass this replay drives is the SAME class
 * production uses (`pipeline-analytics/pipeline/frame-processor.ts`), which is
 * exactly why "we didn't import the writer" has to be enforced, not assumed:
 * the one thing separating a replay track from a production track is that
 * nobody ever calls `TrackStore.upsert` (or notifies, or captures) with it.
 *
 * The operator relocated the UI + orchestration into `addon-benchmark`
 * (2026-08-26) — the single-image tester already lives there and a clip is
 * the same product extended in time. The FrameProcessor pass that stayed in
 * `addon-post-analysis` is gone (D646): every replay directory is now in
 * `addon-benchmark`.
 *
 * (D681, Task 19 fix round 1.) `tracking-bench/` is a second, independent
 * replay boundary — same property, different product: a tape replayed
 * through the SAME `FrameProcessor` production runs must never reach a
 * production writer either. `recorder/` is excluded from this scan: it is
 * the one place under `tracking-bench/` allowed to reach the live pipeline,
 * because it OBSERVES it to WRITE tapes — the same carve-out
 * `bench-isolation.spec.ts` (in that package) already enforces by regex.
 * This script's closed `FORBIDDEN_SYMBOLS` list is a second, independent
 * check of the same property, not a replacement for that spec.
 *
 * ## Why a closed list, not a regex
 *
 * `/.*Store/` would flag `ReplayStore` (the replay's OWN collection) as
 * readily as `TrackStore` (production's). A closed, named list is
 * verifiable at a glance and cannot swallow the exception it needs to make.
 *
 * ## What it cannot see
 *
 * Textual, like every guard in this file's family (see
 * `check-recorded-still-off-delivery-path.ts`). It cannot follow a symbol
 * re-exported under a different name, or a call reached through three
 * indirections. It catches the obvious way to introduce the regression —
 * importing or naming the writer directly where the replay engine lives —
 * which is also the way it would actually happen.
 *
 * Usage: tsx scripts/check-replay-isolation.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

/**
 * Directories under replay's control. The 2026-08-26 relocation had also put
 * a FrameProcessor pass in `addon-post-analysis`; the session replay (D646)
 * compares against STORED tracks instead, and that pass was deleted with its
 * cap method (`runReplayFrameProcessor`) in D646 fix round 1.
 */
const REPLAY_DIRS: readonly string[] = [
  // (The benchmark's session replay and its clip replay were deleted with
  // D791/D792; the node benchmark calls the executor directly and emits
  // nothing — see `pipeline-runner/node-bench`.)
  // The tracking-bench tape replay (D681): reads a tape and a tracker, and
  // must write nothing but its own `ReplayResult`.
  'packages/addon-post-analysis/src/pipeline-analytics/tracking-bench',
]

/**
 * Subdirectories never walked for a given entry of {@link REPLAY_DIRS},
 * relative to that entry. Only `tracking-bench/recorder` needs one today —
 * see the module comment.
 */
const EXCLUDED_SUBDIRS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['packages/addon-post-analysis/src/pipeline-analytics/tracking-bench', new Set(['recorder'])],
])

/**
 * Production writers a replay module may never reach.
 *
 * CLOSED list, not a heuristic: every entry here is a production writer with
 * il suo nome — see the plan's Task 0.1 for the full argument.
 */
export const FORBIDDEN_SYMBOLS: readonly string[] = [
  'TrackStore',
  'EventStore',
  'MediaStore',
  'FaceStore',
  'PlateStore',
  'SensorEventStore',
  'captureScheduler',
  'notificationRules',
  'persistSyntheticTrack',
]

export interface ReplayFile {
  readonly path: string
  readonly source: string
}

export interface ReplayViolation {
  readonly path: string
  readonly symbol: string
}

/** Strip line and block comments so a docstring naming the forbidden
 *  symbol (to explain why it must never be called) does not itself trip
 *  the guard. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

function isReplaySegment(segment: string): boolean {
  return segment === 'replay' || segment.endsWith('-replay') || segment === 'tracking-bench'
}

/**
 * Scan replay files for a forbidden production symbol. Only files whose
 * path has a `replay/` (or `<x>-replay/`, or `tracking-bench/`) segment are
 * considered — the guard's whole reason for being is that directory's
 * boundary.
 */
export function findReplayIsolationViolations(
  files: readonly ReplayFile[],
): readonly ReplayViolation[] {
  const violations: ReplayViolation[] = []
  for (const file of files) {
    // `replay/`, `session-replay/` (D646) and `tracking-bench/` (D681)
    // alike: a segment that NAMES a replay boundary. `includes('replay')`
    // alone skipped every session-replay file while this list claimed to
    // watch them, and `tracking-bench` names its own boundary without the
    // word "replay" at all.
    const segments = file.path.split('/')
    if (!segments.some(isReplaySegment)) continue
    const code = stripComments(file.source)
    for (const symbol of FORBIDDEN_SYMBOLS) {
      if (new RegExp(`\\b${symbol}\\b`).test(code)) {
        violations.push({ path: file.path, symbol })
      }
    }
  }
  return violations
}

function walk(dir: string, excludeDirNames: ReadonlySet<string>, out: string[] = []): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        excludeDirNames.has(entry.name)
      ) {
        continue
      }
      walk(p, excludeDirNames, out)
      continue
    }
    if (/\.tsx?$/.test(entry.name) && !/\.(spec|test)\.tsx?$/.test(entry.name)) out.push(p)
  }
  return out
}

function main(): void {
  const files: ReplayFile[] = []
  for (const dir of REPLAY_DIRS) {
    const excludeDirNames = EXCLUDED_SUBDIRS.get(dir) ?? new Set<string>()
    for (const abs of walk(path.join(ROOT, dir), excludeDirNames)) {
      const rel = path.relative(ROOT, abs).split(path.sep).join('/')
      files.push({ path: rel, source: fs.readFileSync(abs, 'utf8') })
    }
  }

  const violations = findReplayIsolationViolations(files)
  if (violations.length === 0) {
    console.log(
      `\x1b[32m  ✔ replay stays isolated — no production writer reachable from replay/\x1b[0m` +
        (files.length === 0
          ? ' (no replay files exist yet)'
          : ` (${files.length} file(s) checked)`),
    )
    return
  }

  console.error(`\x1b[31m✘ ${violations.length} replay isolation violation(s)\x1b[0m:`)
  for (const v of violations) {
    console.error(`    ${v.path}: reaches \`${v.symbol}\` — a production writer`)
  }
  console.error(
    '    → a replay run must never write where production writes. Construct a fresh\n' +
      "      FrameProcessor and keep results in the replay's own store.",
  )
  process.exit(1)
}

main()
