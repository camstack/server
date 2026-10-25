/**
 * The tracking bench's command line (D681): a LOCAL development tool. Not
 * addon code — it prints through `CliIo` (stdout/stderr), never a logger, and
 * runs from a checkout, never on a node. Nothing here is a CI gate: the
 * committed cases are a test on their own (`cases.spec.ts`).
 *
 *   score <bundle | cases/<slug>> [--plane pipeline|onboard]
 *   case <bundle> [--slug <slug>] [--note "<text>"] [--plane pipeline|onboard]
 *   cases
 *
 * Task 22 review carry-overs (must hold, task-22-review.md M4 and the
 * fixture-privacy note):
 *  - `case` prints a standing reminder that a case is committed to a public
 *    repo, before it does anything else with `--slug`/`--note`.
 *  - Whenever this CLI derives truth from a tape's marks (`case` or `score`),
 *    it prints every `suppressedAuto` pair — the recognizer's cannot-link the
 *    operator's own same-subject mark outranked — so the person committing a
 *    case sees the disagreement `caseFromBundle` otherwise only carries into
 *    the fixture silently.
 *  - `score` prints the case-label report (`formatCaseReport`) next to the
 *    metrics for each tracker: a case asserts only what was labelled, and the
 *    metrics are the only place unlabelled behaviour shows up (task-22-review
 *    M2 — "cases must be read beside the Task 23 metrics, not alone").
 */
import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { type BundleParts, parseBundle } from './bundle.js'
import {
  type CaseContent,
  type CaseManifest,
  caseFromBundle,
  listCaseDirs,
  loadCaseFixture,
  withStatus,
  writeCaseFixture,
} from './cases/case-fixture.js'
import { type CaseReport, formatCaseReport } from './cases/case-labels.js'
import { deriveTruth, type SuppressedAutoCannotLink } from './ground-truth.js'
import { createNoopLogger } from './no-op-logger.js'
import { formatMetricRow, type ScoreInput, scoreTape } from './score.js'
import { type TapePlane, TapePlaneSchema } from './tape-schema.js'
import { replayCase } from './testing/replay-case.js'
import { CASE_TRACKER } from './trackers/case-tracker.js'
import { RecordedTracker } from './trackers/recorded-tracker.js'
import type { TapeTrackerFactory } from './trackers/tape-tracker.js'

export interface CliIo {
  readonly out: (line: string) => void
  readonly err: (line: string) => void
  readonly now: () => number
}

export interface CliOptions {
  readonly casesDir: string
  /** The tracker cases are measured with; `CASE_TRACKER` unless a spec injects one. */
  readonly caseTracker?: TapeTrackerFactory
}

const USAGE =
  'usage: tracking-bench <score <bundle | cases/<slug>> [--plane pipeline|onboard] | ' +
  'case <bundle> [--slug <slug>] [--note "<text>"] [--plane pipeline|onboard] | cases>'

const PRIVACY_WARNING =
  '⚠ a case is committed to a public repo — never put a name or other personal data in --slug or --note'

const RECORDED: TapeTrackerFactory = () => new RecordedTracker()

function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

function sameVerdict(a: CaseReport, b: CaseReport): boolean {
  return JSON.stringify(a.violations) === JSON.stringify(b.violations)
}

/** Task 22 review M4: the only line announcing "the recognizer disagreed with
 *  the operator" for a pair the operator's own same-subject mark outranked —
 *  printed for both `case` (from the fixture it is about to write) and
 *  `score` (derived fresh, since a raw bundle carries none yet). */
function printSuppressedAuto(io: CliIo, pairs: readonly SuppressedAutoCannotLink[]): void {
  for (const p of pairs) {
    io.err(
      `⚠ recognizer disagreed with the operator: ${p.a} (${p.aFid}) and ${p.b} (${p.bFid}) ` +
        `were kept same-subject`,
    )
  }
}

/** A manifest this CLI can read `.plane` off, built for a raw bundle that has
 *  never been through `caseFromBundle` — never written anywhere, only used to
 *  drive the same case-label report a committed case gets (M2). */
function manifestForBundleScore(parts: BundleParts, plane: TapePlane, nowMs: number): CaseManifest {
  const frames = parts.tape.body.filter((r) => r.kind === 'frame' && r.plane === plane).length
  return {
    version: 1,
    slug: parts.manifest.scenario,
    deviceId: parts.manifest.deviceId,
    plane,
    lighting: parts.manifest.lighting,
    status: 'open',
    recordedDate: parts.manifest.recordedDate,
    importedDate: today(nowMs),
    frames,
  }
}

async function loadScoreContent(
  target: string,
  planeArg: string | undefined,
  nowMs: number,
): Promise<CaseContent> {
  if (statSync(target).isDirectory()) {
    const fixture = await loadCaseFixture(target)
    if (planeArg === undefined || TapePlaneSchema.parse(planeArg) === fixture.manifest.plane) {
      return fixture
    }
    return { ...fixture, manifest: { ...fixture.manifest, plane: TapePlaneSchema.parse(planeArg) } }
  }
  const parts = parseBundle(await readFile(target))
  const plane = TapePlaneSchema.parse(planeArg ?? 'pipeline')
  return { manifest: manifestForBundleScore(parts, plane, nowMs), tape: parts.tape, gt: parts.gt }
}

async function score(args: readonly string[], io: CliIo, options: CliOptions): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { plane: { type: 'string' } },
    strict: true,
  })
  const target = positionals[0]
  if (target === undefined) {
    io.err(USAGE)
    return 2
  }
  const content = await loadScoreContent(target, values.plane, io.now())
  const input: ScoreInput = { tape: content.tape, gt: content.gt, plane: content.manifest.plane }
  const truth = deriveTruth(input.tape, input.gt, input.plane, createNoopLogger())
  if (truth.ok) printSuppressedAuto(io, truth.truth.suppressedAuto)
  let failed = false
  for (const factory of [RECORDED, options.caseTracker ?? CASE_TRACKER]) {
    const r = scoreTape(input, factory, io.now)
    if (!r.ok) {
      io.err(`✘ ${r.code} — ${r.detail}`)
      failed = true
      continue
    }
    io.out(`${r.tracker} (${String(r.metrics.frames)} frames, ${String(r.ms)} ms)`)
    for (const line of formatMetricRow(r.metrics)) io.out(line)
    for (const w of r.warnings) io.err(`⚠ ${w}`)
    // Task 22 review M2: a case asserts only what was labelled — show the
    // label checks next to the metrics rather than leave them to a separate
    // command.
    for (const line of formatCaseReport(replayCase(content, factory))) io.out(line)
  }
  return failed ? 1 : 0
}

async function makeCase(args: readonly string[], io: CliIo, options: CliOptions): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      slug: { type: 'string' },
      note: { type: 'string' },
      plane: { type: 'string', default: 'pipeline' },
    },
    strict: true,
  })
  io.err(PRIVACY_WARNING)
  const file = positionals[0]
  if (file === undefined) {
    io.err(USAGE)
    return 2
  }
  const parts = parseBundle(await readFile(file))
  const slug = values.slug ?? parts.manifest.scenario
  if (existsSync(path.join(options.casesDir, slug))) {
    io.err(`✘ refused: case-exists — cases/${slug} is already committed; pick another --slug`)
    return 1
  }
  const made = caseFromBundle(parts, {
    slug,
    plane: TapePlaneSchema.parse(values.plane),
    importedDate: today(io.now()),
    ...(values.note !== undefined ? { note: values.note } : {}),
  })
  if (!made.ok) {
    io.err(`✘ refused: ${made.code} — ${made.detail}`)
    return 1
  }
  printSuppressedAuto(io, made.content.gt.suppressedAuto ?? [])
  const live = replayCase(made.content, RECORDED)
  const current = replayCase(made.content, options.caseTracker ?? CASE_TRACKER)
  const status = current.violations.length === 0 ? 'held' : 'open'
  const dir = await writeCaseFixture(options.casesDir, withStatus(made.content, status))
  for (const line of formatCaseReport(live)) io.out(line)
  for (const line of formatCaseReport(current)) io.out(line)
  if (!sameVerdict(live, current)) {
    io.err(
      '⚠ the replay does not reproduce the live run on this case — an input the recorder does not carry yet (spec §9)',
    )
  }
  io.out(
    status === 'held'
      ? `wrote ${dir} as held: the current tracker honours it, and must keep doing so.`
      : `wrote ${dir} as open: the current tracker does not honour it yet; cases.spec.ts runs it with it.fails until a tracker does.`,
  )
  io.out(`Next: commit ${path.relative(process.cwd(), dir)}.`)
  return 0
}

async function cases(io: CliIo, options: CliOptions): Promise<number> {
  const dirs = listCaseDirs(options.casesDir)
  let failed = false
  for (const dir of dirs) {
    const fixture = await loadCaseFixture(dir)
    const report = replayCase(fixture, options.caseTracker ?? CASE_TRACKER)
    for (const line of formatCaseReport(report)) io.out(line)
    const honoured = report.violations.length === 0
    if (fixture.manifest.status === 'held' && !honoured) {
      io.err(`✘ ${fixture.manifest.slug}: held, but the tracker no longer honours it`)
      failed = true
    } else if (fixture.manifest.status === 'open' && honoured) {
      io.err(
        `✘ ${fixture.manifest.slug}: open, but the tracker honours it now — flip it to held in the same commit`,
      )
      failed = true
    }
  }
  io.out(`${String(dirs.length)} case(s)`)
  return failed ? 1 : 0
}

export async function runCli(
  argv: readonly string[],
  io: CliIo,
  options: CliOptions,
): Promise<number> {
  const [command, ...rest] = argv
  switch (command) {
    case 'score':
      return score(rest, io, options)
    case 'case':
      return makeCase(rest, io, options)
    case 'cases':
      return cases(io, options)
    default:
      io.err(USAGE)
      return 2
  }
}
