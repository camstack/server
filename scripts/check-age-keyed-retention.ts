#!/usr/bin/env tsx
/**
 * Retention guard — there is exactly ONE age-keyed sweep, and it is over
 * TRACKS.
 *
 * ## The failure this catches
 *
 * Analytics retention was ten independent age sweeps that each chose their own
 * cutoff arithmetic and disagreed with each other. Two disagreements were
 * measured on the live fleet, not theorised: CLIP vectors outliving their
 * events by 14–21 days on one camera (events pruned per-device, vectors on the
 * fleet MINIMUM), and 5,598 `keyFrame` media rows whose track had already been
 * pruned. D61 collapsed all of it: an entity a track OWNS has no clock of its
 * own, and leaves only through the track cascade.
 *
 * Nothing about that survives review. Each of the ten was locally reasonable —
 * "media should not grow unbounded", "prune the vectors too" — and each was
 * added by someone doing the obviously right thing in the file they were in.
 * The rule was broken four times before it was even written down. So it gets a
 * check.
 *
 * ## What it checks
 *
 * 1. **No age-keyed deletion outside the declared roots.** A method under
 *    `pipeline-analytics/store/` that both takes a `cutoffMs`-shaped parameter
 *    AND deletes must be on {@link ALLOWED}. Anything else fails.
 * 2. **The removed sweeps stay removed.** The four names that carried the
 *    disagreement (`MediaStore.evictBefore`, `ObjectEmbeddingStore.pruneAll`,
 *    `pruneDeviceBefore`, `FaceStore.prune`) may not come back.
 * 3. **Every collection is classified.** Each `*_COLLECTION` constant declared
 *    under `pipeline-analytics/` must appear in `ANALYTICS_COLLECTIONS`, so a
 *    new store cannot ship without someone deciding, in writing, what happens
 *    to its rows when their owner goes away. That decision being absent is
 *    exactly how the orphans were produced.
 * 4. **The orphan audit stays ownership-keyed.** `orphan-audit.ts` may not gain
 *    a `whereBetween` on a timestamp field — the moment it selects by age it
 *    has become a fifth sweep wearing a different name.
 *
 * ## The false-positive argument
 *
 * Every check is a name or a declaration — present or absent, never a
 * judgement. Specifically:
 *
 * - Check 1 fires only when BOTH conditions hold in the same method body: a
 *   parameter whose name matches {@link CUTOFF_PARAM} *and* a delete call.
 *   A read that filters by age (every query in the codebase) has no delete and
 *   is invisible to it. A delete that is not age-keyed (`deleteByTracks`,
 *   `deleteForOwner`, `deleteByKey`) has no cutoff parameter and is equally
 *   invisible. So the two large, legitimate populations are excluded
 *   structurally, not by heuristic.
 * - It is scoped to `pipeline-analytics/store/**` and to `.ts` files that are
 *   not tests. Other addons have their own ownership models and are none of
 *   this rule's business; saying so is better than a guard that fires on
 *   `notification-center` and gets deleted for it.
 * - {@link ALLOWED} carries a `why` per entry, so widening it is a sentence
 *   someone has to write, not a line someone can slip in.
 *
 * ## What it CANNOT catch — stated plainly
 *
 * **A hand-rolled age delete that never names itself.** A method called
 * `tidy(n: number)` that runs `deleteWhere({ whereBetween: { timestamp: [0, n] } })`
 * defeats every check here, and nothing conservative can catch it: the only
 * signal would be "a number is compared to a timestamp column", which fires on
 * every legitimate query in the repo and would get this file deleted within a
 * week. The same is true of a raw SQL string, or a delete driven by a cutoff
 * computed in the caller and passed as `n`.
 *
 * It also cannot see across process boundaries: another addon deleting
 * analytics rows through the settings-store cap is invisible to it. And it
 * checks NAMES and STRUCTURE, not behaviour — it cannot tell you that the
 * cascade actually reaches every owned family. That is what
 * `retention/__tests__/cascade-completeness.spec.ts` is for, and the two are
 * complementary on purpose: the guard stops a second CLOCK, the test stops a
 * missing EDGE.
 *
 * Usage: tsx scripts/check-age-keyed-retention.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

const ANALYTICS_ROOT = 'packages/addon-post-analysis/src/pipeline-analytics'
const STORE_DIR = `${ANALYTICS_ROOT}/store`
const CLASSIFICATION_FILE = `${ANALYTICS_ROOT}/retention/collection-classification.ts`
const ORPHAN_AUDIT_FILE = `${ANALYTICS_ROOT}/retention/orphan-audit.ts`

/** Parameter names that mean "an instant, and everything before it goes". */
const CUTOFF_PARAM = /\b(?:cutoffMs|cutoff|olderThanMs|beforeMs|[a-zA-Z]+CutoffMs)\s*[?]?\s*:/

/** Calls that remove rows. */
const DELETE_CALL =
  /\.(?:delete|deleteWhere|deleteByFilter|deleteByIds|deleteByKey)\b|\bdrainMatching\(/

interface AllowedSweep {
  readonly file: string
  readonly method: string
  readonly why: string
}

/**
 * The complete set of age-keyed deletions permitted to exist.
 *
 * The membership test is NOT "is it small" or "is it cheap". It is: *can this
 * entity's clock disagree with another entity's clock?* If it can, it is owned,
 * and it belongs in the cascade instead.
 */
const ALLOWED: readonly AllowedSweep[] = [
  {
    file: `${STORE_DIR}/track-store.ts`,
    method: 'listIdsBefore',
    why: 'THE sweep. A track is the ROOT of the analytics data model — the one entity whose age may select, because deleting it takes everything it owns with it. Per-device cutoff (measured 1 day on 104, 7 on 101/102).',
  },
  {
    file: `${STORE_DIR}/event-store.ts`,
    method: 'evictTracklessBefore',
    why: 'motion + audio events. TERMINAL roots — no trackId, nothing references them, so their clock cannot contradict anybody. A motion visit still is event-owned media of that row and leaves in lockstep here. Object events are deliberately NOT in this method; they are track-owned.',
  },
  {
    file: `${STORE_DIR}/event-store.ts`,
    method: 'pruneObjectEventsBefore',
    why: 'OPERATOR-INITIATED only — the "delete events older than X" button, with a cutoff the operator typed. Not on any timer, logged to the ops log, and the one remaining path that can remove a track-owned entity without its track. If this ever appears in a sweep, that is the bug.',
  },
  {
    file: `${STORE_DIR}/event-store.ts`,
    method: 'pruneBefore',
    why: 'OPERATOR-INITIATED only — "delete everything for this camera", reached from `deleteDeviceEvents`. Same argument as pruneObjectEventsBefore.',
  },
  {
    file: `${STORE_DIR}/sensor-event-store.ts`,
    method: 'evictBefore',
    why: 'sensor events. TERMINAL root: a denormalised linked-device state change, owned by nothing. Per-device since D61 (it used to sweep the whole table on the fleet MINIMUM).',
  },
  {
    file: `${STORE_DIR}/ops-log-store.ts`,
    method: 'pruneBefore',
    why: 'the retention AUDIT TRAIL. The one root that must NOT follow a device window — it records what retention did, including for devices that no longer exist, and it is the only reason a future session can tell an eviction from a bug.',
  },
]

/** Names that carried the disagreement and must not come back. */
const FORBIDDEN: ReadonlyArray<{
  readonly file: string
  readonly method: string
  readonly what: string
}> = [
  {
    file: `${STORE_DIR}/media-store.ts`,
    method: 'evictBefore',
    what: 'deleted media rows BY AGE and blind to `ownerKind` — it removed enrolled `identity` crops the cascade was careful to exempt, and needed a fleet-minimum fudge factor to avoid deleting a longer-retention camera’s live media. Media lives exactly as long as its owner.',
  },
  {
    file: `${STORE_DIR}/object-embedding-store.ts`,
    method: 'pruneAll',
    what: 'age-pruned the CLIP index on the fleet MINIMUM cutoff. A vector’s row id IS the trackId; it is owned completely.',
  },
  {
    file: `${STORE_DIR}/object-embedding-store.ts`,
    method: 'pruneDeviceBefore',
    what: 'the per-device version of the same mistake — better arithmetic, same second clock. Measured 14–21 days out of step with its own events.',
  },
  {
    file: `${STORE_DIR}/face-store.ts`,
    method: 'prune',
    what: 'age-pruned a TRACK-OWNED entity (a face row carries a `trackId`) and had no production caller — a leftover describing the wrong design.',
  },
]

interface Problem {
  readonly where: string
  readonly what: string
  readonly fix: string
}

const rel = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/')

const isTest = (relative: string): boolean =>
  relative.includes('__tests__/') || relative.endsWith('.spec.ts') || relative.endsWith('.test.ts')

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

/**
 * Split a file into `(methodName, body)` pairs at class-method granularity.
 *
 * Brace-counting rather than a parser: the shape being matched is
 * `async name(...) { ... }` at class-member indentation, which is the only
 * shape these stores use. A method it fails to split is simply not examined —
 * the guard under-reports rather than fires wrongly, which is the correct bias
 * for something that must never produce a false positive.
 */
function methodBodies(source: string): ReadonlyArray<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = []
  const header =
    /^\s{2}(?:private\s+|protected\s+|public\s+|static\s+)*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm
  for (;;) {
    const match = header.exec(source)
    if (match === null) break
    const name = match[1]
    if (name === undefined || name === 'constructor' || name === 'if' || name === 'for') continue
    const open = source.indexOf('{', match.index + match[0].length - 1)
    if (open === -1) continue
    let depth = 0
    let end = -1
    for (let i = open; i < source.length; i++) {
      const ch = source[i]
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end === -1) continue
    out.push({ name, body: source.slice(match.index, end + 1) })
  }
  return out
}

function checkNoUndeclaredAgeSweep(problems: Problem[]): void {
  const allowed = new Set(ALLOWED.map((a) => `${a.file}#${a.method}`))
  const files: string[] = []
  sourceFiles(path.join(ROOT, STORE_DIR), files)
  for (const file of files) {
    const relative = rel(file)
    if (isTest(relative)) continue
    const source = fs.readFileSync(file, 'utf-8')
    for (const { name, body } of methodBodies(source)) {
      // BOTH must hold. A read that filters by age has no delete; a delete that
      // is not age-keyed has no cutoff parameter. Requiring both is what keeps
      // the two large legitimate populations out of range structurally.
      if (!CUTOFF_PARAM.test(body)) continue
      if (!DELETE_CALL.test(body)) continue
      if (allowed.has(`${relative}#${name}`)) continue
      problems.push({
        where: `${relative}#${name}`,
        what: 'is an AGE-KEYED DELETION that is not a declared retention root',
        fix: 'an entity a track owns has no clock of its own — delete it through the cascade (`TrackScopedStore.deleteByTracks`), or, if it genuinely owns nothing and nothing owns it, add it to RETENTION_ROOTS in `retention/retention-model.ts` AND to ALLOWED in this guard, with a sentence saying why its clock cannot disagree with anybody else’s.',
      })
    }
  }
}

function checkRemovedSweepsStayRemoved(problems: Problem[]): void {
  for (const entry of FORBIDDEN) {
    const full = path.join(ROOT, entry.file)
    if (!fs.existsSync(full)) continue
    const source = fs.readFileSync(full, 'utf-8')
    const declared = new RegExp(`^\\s{2}(?:async\\s+)?${entry.method}\\s*\\(`, 'm').test(source)
    if (!declared) continue
    problems.push({
      where: `${entry.file}#${entry.method}`,
      what: 'is BACK — this method was removed by D61',
      fix: `it ${entry.what}`,
    })
  }
}

function checkEveryCollectionIsClassified(problems: Problem[]): void {
  const classificationPath = path.join(ROOT, CLASSIFICATION_FILE)
  if (!fs.existsSync(classificationPath)) {
    problems.push({
      where: CLASSIFICATION_FILE,
      what: 'is missing — the collection classification is what tells the orphan audit what "owned" means',
      fix: 'restore it, or retire this guard deliberately rather than by deletion',
    })
    return
  }
  const classification = fs.readFileSync(classificationPath, 'utf-8')
  const files: string[] = []
  sourceFiles(path.join(ROOT, ANALYTICS_ROOT), files)
  const declared = new Map<string, string>()
  for (const file of files) {
    const relative = rel(file)
    if (isTest(relative) || relative === CLASSIFICATION_FILE) continue
    const source = fs.readFileSync(file, 'utf-8')
    const re = /export const ([A-Z_]*COLLECTION)\s*=\s*'([^']+)'/g
    for (;;) {
      const match = re.exec(source)
      if (match === null) break
      const constant = match[1]
      if (constant !== undefined) declared.set(constant, relative)
    }
  }
  for (const [constant, where] of declared) {
    if (classification.includes(constant)) continue
    problems.push({
      where,
      what: `declares \`${constant}\` but it is not classified in ${CLASSIFICATION_FILE}`,
      fix: 'every collection must say what happens to its rows when their owner goes away — track-owned (cascades), owner-indirection, a retention root, or never-orphaned. That decision being absent is how 5,598 orphaned media rows were produced.',
    })
  }
}

function checkOrphanAuditHasNoClock(problems: Problem[]): void {
  const full = path.join(ROOT, ORPHAN_AUDIT_FILE)
  if (!fs.existsSync(full)) return
  const source = fs.readFileSync(full, 'utf-8')
  // A `whereBetween` on a time column here would mean the audit had started
  // SELECTING by age — i.e. become a second sweep wearing a different name.
  if (/whereBetween\s*:\s*\{\s*(?:timestamp|lastSeen|at)\b/.test(source)) {
    problems.push({
      where: ORPHAN_AUDIT_FILE,
      what: 'has grown an age RANGE filter — the orphan audit selects by OWNERSHIP, never by age',
      fix: 'the only permitted use of a timestamp here is the grace window, which can exclusively SAVE a row (`ts > graceFloor → skip`). Selecting rows by age makes this a fifth sweep.',
    })
  }
}

function main(): void {
  const problems: Problem[] = []
  checkNoUndeclaredAgeSweep(problems)
  checkRemovedSweepsStayRemoved(problems)
  checkEveryCollectionIsClassified(problems)
  checkOrphanAuditHasNoClock(problems)

  if (problems.length > 0) {
    console.error(`\x1b[31m✘ ${problems.length} retention-model violation(s)\x1b[0m:`)
    for (const p of problems) {
      console.error(`    ${p.where}: ${p.what}`)
      console.error(`      → ${p.fix}`)
    }
    console.error(
      '    Why this matters: ten age sweeps with ten cutoffs disagreed with each other. Two of the disagreements were MEASURED — vectors 14–21 days out of step with their events, and 5,598 media rows whose track was already gone.',
    )
    process.exit(1)
  }
  console.log(
    `  ✔ one age-keyed sweep, over tracks (${ALLOWED.length} declared roots, all collections classified)`,
  )
}

main()
