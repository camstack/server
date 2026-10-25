#!/usr/bin/env tsx
/**
 * Seal-authority guard — a seal is a CLAIM OF COMPLETENESS, and only a party
 * that could KNOW the hour is complete may write one (D521).
 *
 * ## The failure this catches
 *
 * D451 gave `SegmentHourRow` a `sealed` column and closed with the one thing it
 * could not enforce:
 *
 *   "Nothing catches a future `sealed: true` written by a party that cannot
 *    know the hour is complete. That is review only, and it is the one way to
 *    make this record worse than no record at all."
 *
 * The rollover seal it shipped in the same change IS that party. A recorder
 * runner respawned mid-hour, its writer's first finalize created the hour row
 * without the 175 segments the previous process had produced, and at the hour
 * rollover it sealed that row as complete. A sealed row is served to the
 * calendar as the whole hour and never readdir'd again, so camera 101 lost two
 * hours of INTACT footage from the timeline on 2026-09-17 — for the life of the
 * footage. Review did not catch it, in the same record that asked review to.
 *
 * ## What it checks
 *
 * 1. **Every `sealed: true` in the recorder declares an authority.** The method
 *    that writes it must carry `@seal-authority <id>` in its doc comment,
 *    naming what that party KNOWS. A new seal site cannot be added without
 *    writing that sentence, which is the decision that has to be conscious.
 * 2. **Every (file, method, authority) is allowlisted here**, with the reason it
 *    is entitled to claim completeness. A new one fails the build.
 * 3. **The allowlist cannot rot**: an entry naming a site that no longer writes
 *    a seal fails too, so deleting the last seal in a file takes its licence.
 * 4. **The writer's authority is still GATED.** `sealHour` must consult both
 *    `WRITER_HOUR_ENTRY_GRACE_MS` (was this writer here when the hour began?)
 *    and its refusal sets (did everything it produced reach the row?). Removing
 *    either gate is how the defect came back, so removing either fails here.
 *
 * Every check is a declaration or a syntactic match — never a judgement call.
 * What it cannot see is whether the sentence in `@seal-authority` is TRUE; that
 * is what `segment-hour-seal-ownership.spec.ts` is for.
 *
 * Usage: tsx scripts/check-seal-authority.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

/** Where a seal could be written. */
const SCAN_ROOT = 'packages/addon-pipeline/src/recorder'

/** The file whose gates check 4 is about. */
const LEDGER_FILE = 'packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts'

/** What a seal write looks like in source. */
const SEAL_WRITE = /\bsealed:\s*(?:true|1)\b/

/** One licensed party that may claim an hour is complete. */
interface AllowedSeal {
  /** Repo-relative file. Deliberately NOT a line number: those rot in a day. */
  readonly file: string
  /** The method that writes it. */
  readonly method: string
  /** The `@seal-authority` id its doc comment declares. */
  readonly authority: string
  /** What this party KNOWS that entitles it to the claim. */
  readonly why: string
}

/**
 * The complete set of parties that may write a seal.
 *
 * Adding to this list is a decision with a name on it. The question is not "is
 * this code correct", it is **"could this party have observed the whole hour,
 * including the part before it existed?"** A process that started mid-hour, a
 * consumer reading someone else's row, a migration and a boot restore all
 * answer no. The failure direction is free: leaving an hour UNSEALED costs one
 * directory read, once (~3.6 ms cold, D451), and a wrong seal costs the
 * footage, permanently.
 */
const ALLOWED: readonly AllowedSeal[] = [
  {
    file: LEDGER_FILE,
    method: 'adoptWalkedHour',
    authority: 'closed-hour-listing',
    why: 'A directory listing of an hour that is OVER is the one complete answer there is: the past is immutable and no writer can still be appending to it. The caller guarantees the hour is closed — a live hour races its writer and a walk of it is a lower bound (D451).',
  },
  {
    file: LEDGER_FILE,
    method: 'sealHour',
    authority: 'writer-owned-hour',
    why: 'The writer that LEAVES the hour, and only when it entered within WRITER_HOUR_ENTRY_GRACE_MS of the hour start (it was there when the hour began) and nothing it produced was reported lost (markRefused / markHoursRefused). A writer that arrived late is describing an hour a dead process wrote most of (D521).',
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

/** One seal write, as found in a file. */
interface FoundSeal {
  readonly file: string
  readonly line: number
  readonly method: string | null
  readonly authority: string | null
}

/** A class-body method declaration: two spaces, optional modifiers, a name. */
const DECLARATION =
  /^ {2}(?:private |protected |public |static |override |async |\* )*([a-zA-Z][A-Za-z0-9_]*)\s*[(<]/

/**
 * Attribute every seal write to its enclosing method and that method's declared
 * authority.
 *
 * The enclosing method is the nearest declaration ABOVE the write; the
 * authority is the `@seal-authority` tag of the doc block that closes on the
 * line above that declaration. A write with no method above it reports a `null`
 * method and fails as unattributed, which is the honest answer for a seal
 * written from a bare function nobody can name.
 */
function sealsIn(file: string, source: string): readonly FoundSeal[] {
  const lines = source.split('\n')
  const out: FoundSeal[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i] ?? ''
    // A comment describing the defect must not count as writing a seal.
    if (text.trimStart().startsWith('*') || text.trimStart().startsWith('//')) continue
    if (!SEAL_WRITE.test(text)) continue
    let method: string | null = null
    let declaredAt = -1
    for (let j = i; j >= 0; j -= 1) {
      const match = DECLARATION.exec(lines[j] ?? '')
      if (match?.[1] === undefined) continue
      method = match[1]
      declaredAt = j
      break
    }
    let authority: string | null = null
    if (declaredAt > 0 && (lines[declaredAt - 1] ?? '').trim().endsWith('*/')) {
      const block: string[] = []
      for (let j = declaredAt - 1; j >= 0; j -= 1) {
        block.unshift(lines[j] ?? '')
        if ((lines[j] ?? '').trim().startsWith('/**')) break
      }
      const tag = /@seal-authority\s+([a-z0-9-]+)/.exec(block.join('\n'))
      authority = tag?.[1] ?? null
    }
    out.push({ file, line: i + 1, method, authority })
  }
  return out
}

/** The body of one method of the ledger, for the gate check. */
function methodBody(source: string, name: string): string | null {
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const match = DECLARATION.exec(lines[i] ?? '')
    if (match?.[1] !== name) continue
    const body: string[] = []
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j] ?? ''
      if (/^ {2}\}/.test(line)) break
      body.push(line)
    }
    return body.join('\n')
  }
  return null
}

function main(): void {
  const errors: string[] = []
  const found: FoundSeal[] = []
  for (const abs of sources(SCAN_ROOT)) {
    const rel = path.relative(ROOT, abs)
    found.push(...sealsIn(rel, fs.readFileSync(abs, 'utf8')))
  }

  if (found.length === 0) {
    errors.push(
      `${SCAN_ROOT} — not one \`sealed: true\` was found. Either the column is gone (delete this guard and D521 with it) ` +
        `or the pattern moved and this guard is now blind; fix the parser before changing anything else.`,
    )
  }

  const licensed = new Map(ALLOWED.map((entry) => [`${entry.file}::${entry.method}`, entry]))
  const used = new Set<string>()
  for (const seal of found) {
    const id = `${seal.file}::${seal.method ?? '<no enclosing method>'}`
    const entry = licensed.get(id)
    if (entry === undefined) {
      errors.push(
        `${seal.file}:${seal.line.toString()} writes \`sealed: true\` from \`${seal.method ?? 'a bare function'}\`, which is not in the ` +
          `allowlist of scripts/check-seal-authority.ts.\n` +
          `    A seal is a CLAIM that the hour row describes its whole hour: once it is set, every reader is served that row and ` +
          `NOTHING reads the directory again for the life of the footage. Ask what this party observed. A process that started ` +
          `mid-hour did not observe the part before it existed — that is the 2026-09-17 camera-101 defect, two hours of intact ` +
          `footage off the timeline.\n` +
          `    If it genuinely can know, add an entry to ALLOWED saying what it knows, and declare \`@seal-authority <id>\` on the ` +
          `method. If it cannot, leave the row UNSEALED: a reader walks the hour once and seals it from the array.\n` +
          `    See docs/decisions/adr-0521-*.md and adr-0451-*.md.`,
      )
      continue
    }
    used.add(id)
    if (seal.authority === null) {
      errors.push(
        `${seal.file}:${seal.line.toString()} — \`${seal.method ?? '?'}\` writes a seal but its doc comment declares no ` +
          `\`@seal-authority\`. Add \`@seal-authority ${entry.authority}\` and say, in a sentence, what this party KNOWS that ` +
          `entitles it to claim the hour is complete.`,
      )
      continue
    }
    if (seal.authority !== entry.authority) {
      errors.push(
        `${seal.file}:${seal.line.toString()} — \`${seal.method ?? '?'}\` declares \`@seal-authority ${seal.authority}\` but the ` +
          `allowlist licenses \`${entry.authority}\`. One of the two moved; the licence and the claim must name the same party.`,
      )
    }
  }

  for (const entry of ALLOWED) {
    if (used.has(`${entry.file}::${entry.method}`)) continue
    errors.push(
      `scripts/check-seal-authority.ts — stale allowlist entry: ${entry.file} no longer writes a seal from ` +
        `\`${entry.method}\`. Delete the entry; a licence nobody uses is a licence somebody will reuse.`,
    )
  }

  // 4. The writer's authority is CONDITIONAL, and both conditions are gates in
  //    code. This is the shape of the shipped defect: `sealHour` had the
  //    refusal check and nothing about ownership.
  const ledger = read(LEDGER_FILE)
  const seal = methodBody(ledger, 'sealHour')
  if (seal === null) {
    errors.push(
      `${LEDGER_FILE} — \`sealHour\` not found. The rollover seal moved; re-point this guard at wherever it lives now, ` +
        `because the gates below are the only thing standing between a respawned writer and a permanently short hour.`,
    )
  } else {
    if (!seal.includes('WRITER_HOUR_ENTRY_GRACE_MS')) {
      errors.push(
        `${LEDGER_FILE} — \`sealHour\` no longer consults \`WRITER_HOUR_ENTRY_GRACE_MS\`. That gate is what stops a writer ` +
          `that entered an hour LATE from claiming the whole hour (D521): without it, every runner respawn seals away whatever ` +
          `the dead process had not persisted, and no reader ever looks at that directory again.`,
      )
    }
    if (!seal.includes('this.refused') || !seal.includes('refusedWriterHours')) {
      errors.push(
        `${LEDGER_FILE} — \`sealHour\` no longer consults both refusal sets (\`this.refused\` for a durable write this process ` +
          `declined, \`refusedWriterHours\` for segments the watcher reported it never handed over). A writer that was present ` +
          `for the whole hour and LOST part of it is still not a party that knows what the hour holds (D451, D521).`,
      )
    }
  }

  if (errors.length > 0) {
    console.error('✗ seal authority guard\n')
    for (const error of errors) console.error(`  ${error}\n`)
    process.exit(1)
  }
  console.log(
    `✓ seal authority: ${found.length.toString()} seal writes, ${ALLOWED.length.toString()} licensed parties, ` +
      `the writer's seal gated on entry time and on both refusal sets`,
  )
}

main()
