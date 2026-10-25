#!/usr/bin/env tsx
/**
 * Pull-dial guard — the session-decode worker opens its demuxer through ONE
 * seam, and that seam is the one that skips the redundant stream-info probe.
 *
 * ## The failure this catches
 *
 * A cold detection session measured 5.25 s at the median (p90 19.5 s) from
 * attach to first decoded frame, with `forkToFrameMs` at 4 689 ms of it. A
 * trace on device 102 put the restreamer's join burst fully delivered at
 * 0.41 s and the first decoded frame at 3.17 s — nearly three seconds during
 * which a keyframe-first GOP was already sitting inside libav. What spends it
 * is `avformat_find_stream_info`: an RTP input declares no frame rate, so the
 * probe drains the burst in milliseconds and then waits on LIVE packets to
 * estimate one.
 *
 * That probe is redundant on this URL specifically. The worker never dials a
 * camera; it dials the broker's OWN restream, which refuses PLAY until it holds
 * the parameter sets and whose SDP therefore always carries
 * `sprop-parameter-sets`. `pull-demuxer-open.ts` skips the probe and derives
 * geometry from the extradata libav already parsed out of that SDP.
 *
 * ## Why a guard and not a comment
 *
 * `await nav.Demuxer.open(url, { options, signal })` is what this file used to
 * say, it is what every other node-av call site in the repo says, and it is
 * both shorter and obviously correct-looking. Restoring it silently restores
 * the seconds — no error, no log line, nothing failing. There is no test that
 * can see a refactor that has not happened yet, and a reviewer reading the diff
 * would have to already know this measurement to object.
 *
 * ## What it checks
 *
 * 1. `openPullDemuxer` is declared in exactly one file — the owner.
 * 2. No file under `session-decode/` calls `Demuxer.open` / `Demuxer.openSync`
 *    directly. Everything there dials through the owner.
 * 3. The decode worker actually imports the owner — so the seam cannot be
 *    orphaned while the worker quietly grows its own open.
 *
 * Deliberately scoped to `session-decode/`: `addon-decoder-nodeav` and
 * `addon-decoder-ffmpeg` open their own inputs for other planes and are none of
 * this guard's business.
 *
 * Usage: tsx scripts/check-pull-demuxer-open.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

/** The one module allowed to decide how a session-decode pull input is opened. */
const OWNER_FILE = 'packages/addon-pipeline/src/session-decode/pull-demuxer-open.ts'

/** The exported seam every session-decode dial must go through. */
const SEAM = 'openPullDemuxer'

/** The directory this guard governs. */
const SCOPE_DIR = 'packages/addon-pipeline/src/session-decode'

/** The file that must reach the seam — the pull dial itself. */
const DIALLER_FILE = 'packages/addon-pipeline/src/session-decode/decode-worker-child.ts'

/**
 * A direct node-av demuxer open. Matches `Demuxer.open(`, `Demuxer.openSync(`
 * and the `nav.`/`av.` prefixed forms; NOT `Demuxer.openSDP`, which is a
 * different input entirely and no part of this path.
 */
const DIRECT_OPEN = /\bDemuxer\s*\.\s*open(?:Sync)?\s*\(/

/**
 * The ONE sanctioned mention: the adapter injected into {@link SEAM} as its
 * `open` dependency.
 *
 * The seam is deliberately node-av-free so it can be unit-tested without a
 * native module — which means somebody has to hand it the real `Demuxer.open`,
 * and that somebody is the dial. Exempting the adapter SHAPE rather than the
 * file keeps the ban meaningful: a second, plain `await nav.Demuxer.open(url,
 * …)` in the same file still fails.
 */
const SEAM_ADAPTER =
  /\bopen:\s*(?:async\s*)?\([^)]*\)\s*=>\s*[A-Za-z_$][\w$]*\s*\.\s*Demuxer\s*\.\s*open\s*\(/

interface Problem {
  readonly where: string
  readonly what: string
  readonly fix: string
}

const rel = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/')

const isTest = (relative: string): boolean =>
  relative.includes('__tests__/') || relative.endsWith('.spec.ts') || relative.endsWith('.test.ts')

/**
 * Blank out block and line comments. Naive on purpose: a `//` inside a string
 * literal truncates that line, which can only DROP a match and never invent
 * one. Without it this guard's own explanatory docblocks — which name
 * `Demuxer.open` repeatedly, because that is the thing being banned — would
 * fail the build, and a guard that fires on its own rationale gets deleted.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, ' ')
}

function sourceFiles(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      sourceFiles(full, out)
      continue
    }
    if (entry.name.endsWith('.ts')) out.push(full)
  }
}

function checkSingleOwner(problems: Problem[]): void {
  const files: string[] = []
  sourceFiles(path.join(ROOT, 'packages'), files)
  const declaring = files.filter((file) => {
    const relative = rel(file)
    if (isTest(relative)) return false
    return new RegExp(`export\\s+async\\s+function\\s+${SEAM}\\b`).test(
      fs.readFileSync(file, 'utf-8'),
    )
  })

  if (declaring.length === 1 && rel(declaring[0]!) === OWNER_FILE) return
  if (declaring.length === 0) {
    problems.push({
      where: OWNER_FILE,
      what: `\`${SEAM}\` is not declared anywhere`,
      fix: 'this guard is checking a seam that no longer exists — restore it, or retire the guard deliberately rather than by deletion',
    })
    return
  }
  for (const file of declaring) {
    if (rel(file) === OWNER_FILE) continue
    problems.push({
      where: rel(file),
      what: `a SECOND \`${SEAM}\` is declared here`,
      fix: `there is one pull-open policy, in ${OWNER_FILE} — import it instead of redeclaring it`,
    })
  }
}

function checkNoDirectOpen(problems: Problem[]): void {
  const files: string[] = []
  sourceFiles(path.join(ROOT, SCOPE_DIR), files)
  for (const file of files) {
    const relative = rel(file)
    if (relative === OWNER_FILE || isTest(relative)) continue
    const source = stripComments(fs.readFileSync(file, 'utf-8'))
    const offending = source
      .split('\n')
      .filter((line) => DIRECT_OPEN.test(line) && !SEAM_ADAPTER.test(line))
    if (offending.length === 0) continue
    problems.push({
      where: relative,
      what: 'opens a demuxer directly',
      fix: `dial through \`${SEAM}\` (${OWNER_FILE}). A direct open re-runs \`avformat_find_stream_info\`, which on an RTP input waits on live packets to estimate a frame rate the SDP already declared — measured at ~2.7 s of the cold start, with nothing failing and nothing logged.`,
    })
  }
}

function checkDiallerUsesSeam(problems: Problem[]): void {
  const full = path.join(ROOT, DIALLER_FILE)
  if (!fs.existsSync(full)) {
    problems.push({
      where: DIALLER_FILE,
      what: 'does not exist',
      fix: 'this guard names the pull dial by path — update it if the file moved',
    })
    return
  }
  const source = stripComments(fs.readFileSync(full, 'utf-8'))
  if (new RegExp(`import[^;]*\\b${SEAM}\\b[^;]*from`, 's').test(source)) return
  problems.push({
    where: DIALLER_FILE,
    what: `does not import \`${SEAM}\``,
    fix: `the pull dial must go through the seam — an owner nobody imports is a probe skip nobody gets`,
  })
}

function main(): void {
  const problems: Problem[] = []
  checkSingleOwner(problems)
  checkNoDirectOpen(problems)
  checkDiallerUsesSeam(problems)

  if (problems.length > 0) {
    console.error(`\x1b[31m✘ ${problems.length} pull-dial violation(s)\x1b[0m:`)
    for (const p of problems) {
      console.error(`    ${p.where}: ${p.what}`)
      console.error(`      → ${p.fix}`)
    }
    process.exit(1)
  }
  console.log('  ✔ session-decode opens its pull input through one probe-skipping seam')
}

main()
