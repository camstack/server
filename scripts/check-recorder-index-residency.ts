#!/usr/bin/env tsx
/**
 * Residency guard — the RAM index answers about what is RESIDENT; the ledger is
 * the archive's authority (D295).
 *
 * ## The failure this catches
 *
 * D287 stopped the recorder's boot from loading the archive: `RecordingIndex`
 * now holds the live tail plus the hours somebody hydrated on demand. Every
 * consumer that treated it as the whole archive began seeing a fraction, and
 * **nothing announced it** — a partial answer and a complete one are the same
 * array, so the operation finishes everything it was given and reports success.
 *
 * On 2026-08-29 a storage migration drained `recordingsLow:default` from
 * `index.segmentsOnLocation(from.id)`. The index held 29 218 row slots across
 * ALL locations and profiles; the ledger held 145 664 segments / 846 hours /
 * 80.3 GB on that one location. The mover ran 723 s, processed its short list
 * and correctly reported `done`. 80.3 GB stayed on the source and not one line
 * said so.
 *
 * §P4 of `docs/design/plans/2026-08-29-memory-cpu-execution-plan.md` had
 * already named this exact defect for a DIFFERENT caller (`pruneFootage`) days
 * earlier. The paragraph existed and did not stop it. Hence a guard.
 *
 * ## What it checks
 *
 * 1. **Every public method of `RecordingIndex` carries a `@residency` verdict.**
 *    `archive-shaped` = it answers "what exists"; `resident-scoped` = it answers
 *    about the live tail or an explicitly hydrated window; `mutation` = it
 *    writes. A new method cannot be added without classifying it, which is the
 *    decision that has to be conscious.
 * 2. **Every call site of an `archive-shaped` read is allowlisted here**, with a
 *    reason. A new one fails the build and points the author at D295.
 * 3. **The allowlist cannot rot**: an entry naming a call site that no longer
 *    exists fails too, so removing the last archive-shaped read from a file
 *    removes its licence with it.
 *
 * Every check is a declaration or a syntactic call — never a judgement call.
 * What it cannot see is a caller that reaches the same rows another way; that
 * is what the "I saw N of M" reports on the operations themselves are for.
 *
 * Usage: tsx scripts/check-recorder-index-residency.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

/** The one class this guard is about. */
const INDEX_FILE = 'packages/addon-pipeline/src/recorder/recording-index.ts'

/** Where an archive-shaped read could be called from. */
const SCAN_ROOT = 'packages/addon-pipeline/src'

const VERDICTS = ['archive-shaped', 'resident-scoped', 'mutation'] as const
type Verdict = (typeof VERDICTS)[number]

/** One licensed archive-shaped call site. */
interface AllowedCall {
  /** Repo-relative file. Deliberately NOT a line number: those rot in a day. */
  readonly file: string
  readonly method: string
  /** Why this caller may treat the resident index as the archive. */
  readonly why: string
}

/**
 * The complete set of places an `archive-shaped` read is still called.
 *
 * Adding to this list is a decision with a name on it. Before you do: the
 * question is not "is this convenient", it is **"what does this operation do if
 * the index holds a tenth of the archive, and would anyone find out?"** If the
 * answer is "a fraction of its job, silently", the fix is the ledger
 * (`SegmentHourLedger.census` / `.streamSegments`), not an entry here.
 */
const ALLOWED: readonly AllowedCall[] = [
  {
    file: 'packages/addon-pipeline/src/recorder/relocate-engine.ts',
    method: 'segmentsOnLocation',
    why: 'The NO-LEDGER fallback only. A node that never declared the collection has no archive, and a mover that refuses to move is worse than one that moves what it can see — but the branch announces itself ("the work list is what the RAM index holds"), and the coverage report then says the coverage is UNKNOWN rather than complete.',
  },
  {
    file: 'packages/addon-pipeline/src/recorder/addon/recording-provider.ts',
    method: 'segments',
    why: 'Three window-scoped reads that hydrate FIRST and then over-read: the profile-set derivation in buildPlaybackManifest, and the two calendar-less legacy fallbacks in getAvailability / getDaysWithRecordings. Each is asked about a window the caller has just walked, so the rows it needs are resident by construction; the extra rows are surplus, never a shortfall. Plus rescanStorage`s itemsAffected, which follows a whole-device disk walk.',
  },
  {
    file: 'packages/addon-pipeline/src/recorder/addon/recording-provider.ts',
    method: 'accounting',
    why: '`statusFor`s storageBytes, and the RESIDENT columns of getStorageUsage. The per-camera `usedBytes` / `oldestMs` are no longer this call — D418 moved them to `SegmentHourLedger.usageByDevice`, and what is left is reported under names that SAY residency (`residentBytes` / `residentOldestMs`). `statusFor.storageBytes` is the remaining known under-report: it is one number on a per-device status poll, it acts on nothing, and giving it the archive means a per-device scope on a polled path — named in the D418 record as the next one.',
  },
  {
    file: 'packages/addon-pipeline/src/recorder/addon/recording-provider.ts',
    method: 'piles',
    why: 'The operator-armed rebalance PLAN (D116). Under-reports piles for cold cameras, so the plan proposes fewer moves than it should — it never proposes a wrong one, and every move it does propose is executed by the archive-backed mover. Named in the D295 census.',
  },
  {
    file: 'packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts',
    method: 'segments',
    why: '`reconcileFromIndex`, which runs only after `hydrateDeviceFromStorage` has walked that device end-to-end — the operator-armed rescan. The walk IS the archive for those devices, and the ledger`s own refusal machinery (LEDGER_PRUNE_FLOOR_ROWS / LEDGER_PRUNE_MAX_SHARE, D148) is what covers a walk that saw too little.',
  },
  {
    file: 'packages/addon-pipeline/src/recorder/addon/index.ts',
    method: 'segments',
    why: 'The export engine`s window read, which calls hydrateWindowFromStorage for the same window immediately before. Over-broad, never short.',
  },
  {
    file: 'packages/addon-pipeline/src/recorder/addon/index.ts',
    method: 'accountingByProfile',
    why: 'The placement pass`s per-(camera, profile) demand RATE only — `dailyBytesFor`, which divides resident bytes by the resident span. Self-normalising over whatever window is resident, and an unknown rate is a legitimate 0 that the planner reads as "balance by count". The WORK SET was the other half of this call and was NOT self-normalising: a (camera, profile) with no resident rows was never planned and was then deleted from the durable placement blob by a whole-record replace (D299). It now comes from `SegmentHourLedger.profilesWithFootage`, the always-resident T1 hour summary, and the write merges.',
  },
]

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/** Every `.ts` under a repo-relative directory, excluding test trees. */
function sources(rel: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') {
          continue
        }
        walk(full)
        continue
      }
      if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) out.push(full)
    }
  }
  walk(path.join(ROOT, rel))
  return out
}

/**
 * The public methods of `RecordingIndex` and the `@residency` verdict each one
 * declares.
 *
 * Class-body indentation is the discriminator: a public method sits at exactly
 * two spaces and does not start with `private` / `static` / `constructor`.
 */
function verdicts(source: string): { methods: Map<string, Verdict | null>; errors: string[] } {
  const lines = source.split('\n')
  const methods = new Map<string, Verdict | null>()
  const errors: string[] = []
  const declaration =
    /^ {2}(?!private |static |constructor|readonly |\/|\*)([a-zA-Z][A-Za-z0-9_]*)\(/
  for (let i = 0; i < lines.length; i += 1) {
    const match = declaration.exec(lines[i] ?? '')
    if (match === null) continue
    const name = match[1]
    if (name === undefined) continue
    // The nearest doc block ABOVE the declaration, if the line before it closes one.
    let verdict: Verdict | null = null
    if ((lines[i - 1] ?? '').trim().endsWith('*/')) {
      const block: string[] = []
      for (let j = i - 1; j >= 0; j -= 1) {
        block.unshift(lines[j] ?? '')
        if ((lines[j] ?? '').trim().startsWith('/**')) break
      }
      const doc = block.join('\n')
      for (const candidate of VERDICTS) {
        if (doc.includes(`@residency ${candidate}`)) verdict = candidate
      }
    }
    if (verdict === null) {
      errors.push(
        `${INDEX_FILE}:${(i + 1).toString()} — \`${name}\` declares no \`@residency\` verdict. ` +
          `Add one of ${VERDICTS.join(' / ')} to its doc comment: since D287 the index is not the archive, ` +
          `and a read whose residency nobody classified is how the next silent under-report ships.`,
      )
    }
    methods.set(name, verdict)
  }
  return { methods, errors }
}

/**
 * Every method body in the class, public and private, by name.
 *
 * Brace-counted from the declaration line, so it sees what a method actually
 * CALLS rather than what its doc comment claims. Used by the growth check
 * below, which is the only one of these checks that reads a body.
 */
function methodBodies(source: string): Map<string, string> {
  const lines = source.split('\n')
  const out = new Map<string, string>()
  const declaration = /^ {2}(?:private |static |)([a-zA-Z][A-Za-z0-9_]*)\(/
  for (let i = 0; i < lines.length; i += 1) {
    const match = declaration.exec(lines[i] ?? '')
    if (match === null) continue
    const name = match[1]
    if (name === undefined) continue
    const body: string[] = []
    let depth = 0
    let opened = false
    for (let j = i; j < lines.length; j += 1) {
      const line = lines[j] ?? ''
      body.push(line)
      for (const ch of line) {
        if (ch === '{') {
          depth += 1
          opened = true
        } else if (ch === '}') depth -= 1
      }
      if (opened && depth <= 0) break
    }
    out.set(name, body.join('\n'))
  }
  return out
}

function main(): void {
  const errors: string[] = []
  const indexSource = read(INDEX_FILE)
  const { methods, errors: verdictErrors } = verdicts(indexSource)
  errors.push(...verdictErrors)
  if (methods.size === 0) {
    errors.push(
      `${INDEX_FILE} — no public methods parsed. The class shape changed and this guard is now blind; fix the parser before changing anything else.`,
    )
  }

  const archiveShaped = new Set(
    [...methods].filter(([, v]) => v === 'archive-shaped').map(([name]) => name),
  )
  if (archiveShaped.size === 0) {
    errors.push(
      `${INDEX_FILE} — not one method is \`archive-shaped\`. \`segments\`, \`segmentsOnLocation\`, \`accounting\` and \`piles\` all visit every row the index holds; a run in which none of them is classified that way means the verdicts were removed, not that the class became safe.`,
    )
  }

  // Which (file, method) pairs actually call an archive-shaped read.
  const found = new Map<string, Set<string>>()
  for (const abs of sources(SCAN_ROOT)) {
    const rel = path.relative(ROOT, abs)
    if (rel === INDEX_FILE) continue
    const text = fs.readFileSync(abs, 'utf8')
    for (const method of archiveShaped) {
      // `.method(` — a call, not a mention. Comments are stripped first so a
      // doc comment naming the defect does not become a violation.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      if (!new RegExp(`\\.${method}\\s*\\(`).test(code)) continue
      const set = found.get(rel) ?? new Set<string>()
      set.add(method)
      found.set(rel, set)
    }
  }

  const licensed = new Set(ALLOWED.map((a) => `${a.file}::${a.method}`))
  for (const [file, called] of found) {
    for (const method of called) {
      if (licensed.has(`${file}::${method}`)) continue
      errors.push(
        `${file} calls \`RecordingIndex.${method}\`, an \`archive-shaped\` read, and is not in the allowlist of ` +
          `scripts/check-recorder-index-residency.ts.\n` +
          `    Since D287 that call answers about what is RESIDENT — the live tail plus whatever an operator ` +
          `happened to view — not about what EXISTS. If this operation reasons about the archive (a drain, a prune, ` +
          `a delete, a total), read the ledger instead: \`SegmentHourLedger.census\` for the count and ` +
          `\`.streamSegments\` for a bounded oldest-first walk. If it genuinely only needs the resident rows, add an ` +
          `entry to ALLOWED saying so — and say what happens when the index holds a tenth of the archive.\n` +
          `    See docs/decisions/adr-0295-*.md and docs/design/2026-08-29-recorder-index-at-scale.md §3.`,
      )
    }
  }

  for (const entry of ALLOWED) {
    if (found.get(entry.file)?.has(entry.method) === true) continue
    errors.push(
      `scripts/check-recorder-index-residency.ts — stale allowlist entry: ${entry.file} no longer calls ` +
        `\`${entry.method}\`. Delete the entry; a licence nobody uses is a licence somebody will reuse.`,
    )
  }

  // ── The bound, and whether anything is holding it (D524) ────────────────
  //
  // The index is not merely "not the archive", it is BOUNDED: it drops the
  // hours nobody asked about and makes the reader walk the directory again.
  // Two things must stay true for that to be more than a comment.

  // 1. A method that can GROW the index hands control to the eviction pass.
  //    `mapFor` is the only way to create or reach a device's row map, so a new
  //    growth path is a new `mapFor` caller — and one that never enforces is an
  //    unbounded path straight back to a 1 GB index.
  const bodies = methodBodies(indexSource)
  if (!bodies.has('enforceResidency')) {
    errors.push(
      `${INDEX_FILE} — \`enforceResidency\` is gone. The index is unbounded again; adr-0524 measured what ` +
        `1.6 M resident rows cost (1039 MB, 681 B/row) against a 3072 MB old space.`,
    )
  }
  for (const [name, body] of bodies) {
    if (name === 'mapFor' || name === 'enforceResidency') continue
    if (!/this\.mapFor\s*\(/.test(body)) continue
    if (/this\.enforceResidency\s*\(/.test(body)) continue
    errors.push(
      `${INDEX_FILE} — \`${name}\` grows the index (it calls \`mapFor\`) and never calls ` +
        `\`this.enforceResidency()\`. Every path that adds rows must be able to give them back: the index is ` +
        `allowed a declared budget (\`RecordingIndexBudget\`), not the archive.`,
    )
  }

  // 2. Production ARMS it. An index nobody armed never evicts — correct for a
  //    unit test, and the whole defect for the recorder.
  const armed = sources(SCAN_ROOT).some((abs) =>
    /\.armResidency\s*\(/.test(fs.readFileSync(abs, 'utf8')),
  )
  if (!armed) {
    errors.push(
      `${SCAN_ROOT} — nothing calls \`RecordingIndex.armResidency\`. The recorder addon must arm the index in ` +
        `\`onInitialize\` (it is a field initializer and cannot see \`ctx.logger\`); an unarmed index holds every ` +
        `hour any reader ever walked, for the life of the process.`,
    )
  }

  if (errors.length > 0) {
    console.error('✗ recorder index residency guard\n')
    for (const error of errors) console.error(`  ${error}\n`)
    process.exit(1)
  }
  console.log(
    `✓ recorder index residency: ${archiveShaped.size.toString()} archive-shaped reads, ` +
      `${ALLOWED.length.toString()} licensed call sites, every public method classified`,
  )
}

main()
