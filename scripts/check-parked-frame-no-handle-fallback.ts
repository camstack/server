#!/usr/bin/env tsx
/**
 * Parked-frame guard — a retrieval keyed by a TRACK never reaches back for
 * pixels by HANDLE, and the by-handle fetch lives in one file.
 *
 * ## The failure this catches
 *
 * A track's media used to be resolved by frame handle, LATE: the hub decided
 * "this frame is the best", then asked the node for the pixels. The design's
 * own window was 150–500 ms; nothing enforced it, two paths grew past it, and
 * the node had to keep 160 MB of full-resolution surfaces plus a 4 096-entry
 * lease registry alive to answer asks that arrived 30 s later. Bounding the
 * lease at 10 s (D419) took the fleet's keyFrame presence from 99.5% to 76.6%
 * in an afternoon, because the asks were still late — they had just started
 * being refused.
 *
 * D422 inverts it: the frame is PARKED on the owning node the instant it is
 * judged relevant, and every later consumer retrieves by
 * `(deviceId, trackId, kind)`. That only holds while no consumer quietly grows
 * a handle fallback back — "just in case the parcel is missing" is exactly the
 * late ask, one design later. It is a one-line change that reads as prudence,
 * so it gets a check.
 *
 * ## What it checks (all with comments stripped — prose may name anything)
 *
 * 1. In `addon-post-analysis`, the by-handle cap `getNativeCrop` is invoked
 *    ONLY from {@link HANDLE_FETCH_OWNER}. Every by-handle pixel read on the
 *    hub goes through that one transport, where the enrichment horizon is the
 *    contract.
 * 2. The track-keyed files ({@link TRACK_KEYED_FILES}) name no by-handle fetch
 *    and do not import the transport. A parcel client that can call
 *    `getNativeKeyFrameRgb` is a fallback waiting to be written.
 * 3. The retired by-handle rungs stay retired ({@link RETIRED_NAMES}): the
 *    detail dispatcher's full-frame-by-handle rung and the transport's
 *    full-frame JPEG fetch that served it.
 * 4. The two consumers that read a parcel declare it REQUIRED
 *    ({@link REQUIRED_PARCEL_DEPS}): an optional dep with an `else` branch is
 *    where the handle path would come back.
 * 5. The runner's parcel store keys by `(deviceId, trackId, kind)` and knows
 *    nothing of handles: {@link PARCEL_STORE} must not import `FrameHandle`.
 *
 * ## What it cannot catch
 *
 * A by-handle fetch renamed to something this file does not list, or a raw
 * `api.pipelineRunner.getNativeCrop` reached through a variable. Both would
 * have to be written on purpose, and the transport's own docblock says why
 * not. Behaviour — that the park actually fires on a best-frame decision — is
 * `key-frame-retry-e2e.spec.ts`'s job; this guard stops the SHAPE from
 * regressing.
 *
 * Usage: tsx scripts/check-parked-frame-no-handle-fallback.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const PACKAGE_SRC = 'packages/addon-post-analysis/src'

/** The one hub-side file that may ask a node for pixels by handle. */
const HANDLE_FETCH_OWNER = `${PACKAGE_SRC}/pipeline-analytics/runtime/native-frame-transport.ts`

/** The by-handle cap. Its invocation shape, not its name in prose. */
const HANDLE_CAP_INVOCATION = /\bgetNativeCrop\s*(?:\.\s*query)?\s*\(/

/**
 * Files whose reads are keyed by a track, with the reason each is listed.
 * None may name a by-handle fetch or import the transport.
 */
const TRACK_KEYED_FILES: ReadonlyArray<{ readonly file: string; readonly why: string }> = [
  {
    file: `${PACKAGE_SRC}/pipeline-analytics/runtime/parked-frame-client.ts`,
    why: 'the parcel client answers by (deviceId, trackId, kind) from the node the park landed on — a handle fetch here is the late ask D422 retired',
  },
  {
    file: `${PACKAGE_SRC}/pipeline-analytics/pipeline/key-frame-persist.ts`,
    why: 'the keyFrame writer reads the parked parcel; a `frameHandle` in its input is the 10 s-bound loss (D420) one design later',
  },
  {
    file: `${PACKAGE_SRC}/pipeline-analytics/pipeline/track-park.ts`,
    why: 'the park ORDER names the handle for the runner to cut from; it must not also fetch through it',
  },
]

/** The by-handle fetch surface, as invocation shapes. */
const HANDLE_FETCH_NAMES: readonly string[] = [
  'getNativeCrop',
  'getNativeKeyFrameRgb',
  'getNativeFullFrameRgb',
  'getNativeCropJpeg',
  'getRemoteFrame',
  'tryNativeCrop',
  'captureCrop',
  'captureDisplayCrop',
]

/** Names of the retired by-handle rungs. A comeback is a design reversal. */
const RETIRED_NAMES: ReadonlyArray<{ readonly name: string; readonly why: string }> = [
  {
    name: 'captureFullFrameBase64',
    why: "the detail dispatcher's full-frame-by-handle rung — replaced by `captureParkedFrame` (the parked key frame, by track)",
  },
  {
    name: 'getFullFrameJpegBase64',
    why: 'the transport fetch that served that rung; the only caller is gone and a new one would be a second late ask',
  },
  {
    name: 'fetchNativeFullFrameByHandle',
    why: 'never existed — listed so the obvious rename of the retired fetch is refused too',
  },
]

/** Parcel deps that must be REQUIRED — an optional one grows an `else`. */
const REQUIRED_PARCEL_DEPS: ReadonlyArray<{
  readonly file: string
  readonly dep: string
}> = [
  {
    file: `${PACKAGE_SRC}/pipeline-analytics/services/event-media-dispatcher.ts`,
    dep: 'getParkedSubjectSlab',
  },
]

/** The runner's parcel store — keyed by track, blind to handles. */
const PARCEL_STORE = 'packages/addon-pipeline/src/session-decode/parked-frame-store.ts'

interface Problem {
  readonly where: string
  readonly what: string
  readonly fix: string
}

function sourceFiles(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__') {
        continue
      }
      sourceFiles(full, out)
      continue
    }
    if (!entry.name.endsWith('.ts')) continue
    if (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.test.ts')) continue
    out.push(full)
  }
}

const rel = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/')

/**
 * Blank out block and line comments. Deliberately naive: a `//` inside a
 * string literal truncates that line, which can only DROP a match, never
 * invent one — the same trade `check-clip-crop-single-owner.ts` makes.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

function read(relative: string): string | null {
  const full = path.join(ROOT, relative)
  if (!fs.existsSync(full)) return null
  return stripComments(fs.readFileSync(full, 'utf-8'))
}

function checkHandleCapSingleOwner(files: readonly string[], problems: Problem[]): void {
  let ownerInvokes = false
  for (const file of files) {
    const relative = rel(file)
    const source = stripComments(fs.readFileSync(file, 'utf-8'))
    if (!HANDLE_CAP_INVOCATION.test(source)) continue
    if (relative === HANDLE_FETCH_OWNER) {
      ownerInvokes = true
      continue
    }
    problems.push({
      where: relative,
      what: 'invokes the by-handle cap `getNativeCrop` directly',
      fix: `every by-handle pixel read goes through ${HANDLE_FETCH_OWNER}; a consumer keyed by a track reads a PARKED parcel through runtime/parked-frame-client.ts instead`,
    })
  }
  if (!ownerInvokes) {
    problems.push({
      where: HANDLE_FETCH_OWNER,
      what: 'no longer invokes `getNativeCrop` — the guard is checking a shape that moved',
      fix: 'update HANDLE_FETCH_OWNER / HANDLE_CAP_INVOCATION deliberately rather than letting the check go vacuous',
    })
  }
}

function checkTrackKeyedFilesAreHandleFree(problems: Problem[]): void {
  for (const entry of TRACK_KEYED_FILES) {
    const source = read(entry.file)
    if (source === null) {
      problems.push({
        where: entry.file,
        what: 'is listed as a track-keyed file but does not exist',
        fix: 'D422 moved it — update TRACK_KEYED_FILES rather than leaving a dead entry',
      })
      continue
    }
    for (const name of HANDLE_FETCH_NAMES) {
      if (!new RegExp(`\\b${name}\\s*\\(`).test(source)) continue
      problems.push({
        where: entry.file,
        what: `calls \`${name}(\` — a by-handle fetch inside a track-keyed read`,
        fix: entry.why,
      })
    }
    if (/from\s+['"][^'"]*native-frame-transport(?:\.js)?['"]/.test(source)) {
      problems.push({
        where: entry.file,
        what: 'imports the by-handle transport',
        fix: entry.why,
      })
    }
  }
}

function checkRetiredNamesStayRetired(files: readonly string[], problems: Problem[]): void {
  for (const file of files) {
    const source = stripComments(fs.readFileSync(file, 'utf-8'))
    for (const retired of RETIRED_NAMES) {
      if (!new RegExp(`\\b${retired.name}\\b`).test(source)) continue
      problems.push({
        where: rel(file),
        what: `names \`${retired.name}\` — a retired by-handle rung`,
        fix: retired.why,
      })
    }
  }
}

function checkParcelDepsRequired(problems: Problem[]): void {
  for (const entry of REQUIRED_PARCEL_DEPS) {
    const source = read(entry.file)
    if (source === null) {
      problems.push({
        where: entry.file,
        what: 'does not exist',
        fix: 'update REQUIRED_PARCEL_DEPS deliberately',
      })
      continue
    }
    if (new RegExp(`\\b${entry.dep}\\?\\s*:`).test(source)) {
      problems.push({
        where: entry.file,
        what: `declares \`${entry.dep}\` OPTIONAL`,
        fix: 'a parcel source is required: an optional one grows an `else` branch, and that branch is the handle fallback D422 forbids',
      })
    } else if (!new RegExp(`\\b${entry.dep}\\s*:`).test(source)) {
      problems.push({
        where: entry.file,
        what: `no longer declares \`${entry.dep}\``,
        fix: 'the best-shot thumbnail reads the parked slab by track; restore the dep or update REQUIRED_PARCEL_DEPS deliberately',
      })
    }
  }
}

function checkParcelStoreIsHandleBlind(problems: Problem[]): void {
  const source = read(PARCEL_STORE)
  if (source === null) {
    problems.push({
      where: PARCEL_STORE,
      what: 'does not exist',
      fix: 'the runner keeps parcels here; update PARCEL_STORE deliberately',
    })
    return
  }
  if (/\bFrameHandle\b/.test(source)) {
    problems.push({
      where: PARCEL_STORE,
      what: 'names `FrameHandle`',
      fix: 'a parcel is keyed by (deviceId, trackId, kind) and retrieved by exactly that — the store must not be able to answer by handle',
    })
  }
}

function main(): void {
  const files: string[] = []
  sourceFiles(path.join(ROOT, PACKAGE_SRC), files)
  if (files.length === 0) {
    console.error('\x1b[31m✘ no source files found — check the repo layout\x1b[0m')
    process.exit(1)
  }

  const problems: Problem[] = []
  checkHandleCapSingleOwner(files, problems)
  checkTrackKeyedFilesAreHandleFree(problems)
  checkRetiredNamesStayRetired(files, problems)
  checkParcelDepsRequired(problems)
  checkParcelStoreIsHandleBlind(problems)

  if (problems.length > 0) {
    console.error(`\x1b[31m✘ ${problems.length} parked-frame violation(s)\x1b[0m:`)
    for (const p of problems) {
      console.error(`    ${p.where}: ${p.what}`)
      console.error(`      → ${p.fix}`)
    }
    console.error(
      '    Why this matters: a retrieval keyed by a track that falls back to a handle is the late ask that took keyFrame presence from 99.5% to 76.6% (D420), one design later.',
    )
    process.exit(1)
  }
  console.log('  ✔ track-keyed media reads a parked parcel and never falls back to a frame handle')
}

main()
