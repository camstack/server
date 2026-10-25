#!/usr/bin/env tsx
/**
 * Durable-state guard — a NEW declared collection must say what class of fact
 * it holds, and the duplicated durable primitives must not drift apart.
 *
 * ## What this catches, and what it cost to learn
 *
 * The 2026-08-13 census (`docs/design/2026-08-13-durable-value-tracking-and-
 * runtime-state.md`) walked 24 stores by hand and found that nothing anywhere
 * answered "what survives a restart, and who owns it". Two of the 24 turned out
 * to hold state nobody had ever decided the class of, and BOTH were live
 * cold-start bugs:
 *
 *  - `NodeStressController`'s move history — the 4-moves/hour budget, the
 *    per-device cooldown and the return ban all read off one RAM array, so
 *    every restart granted a fresh budget. Classified `ledger`, it could never
 *    have been left in RAM.
 *  - `DeviceFeaturesMirror` — a `mirror` that was never seeded, so the first
 *    read after a boot resolved `[]` and dialled a sleeping battery camera
 *    awake. Classified `mirror`, the rule "rehydrate from the authority at
 *    boot" is exactly what was missing.
 *
 * Both were locally reasonable in the file they were written in. That is what
 * makes them a guard rather than a paragraph.
 *
 * ## Check 1 — every declared collection is classified
 *
 * A collection found by `parse-storage`'s declaration scan must carry a
 * `@durable class=… owner=… write="…" retention="…"` annotation on the constant
 * that names it, OR appear in {@link BACKLOG}.
 *
 * {@link BACKLOG} is the set that existed before the annotation did. **It may
 * only ever shrink** — the guard fails if a name in it no longer needs to be
 * there, so the list cannot quietly become a place to put new things. A new
 * collection is never in it, so a new collection must be classified.
 *
 * ## Check 2 — the duplicated primitives are byte-identical
 *
 * `durable-ledger.ts` and `lts-aggregator.ts` exist in both
 * `addon-post-analysis` and `addon-pipeline-orchestrator`, because addons never
 * import each other and a framework home rides a release train while these
 * ship with `camstack deploy`. A duplicate that drifts is worse than either
 * copy: the two addons would disagree about what "durable" means while looking
 * identical. So the bytes are compared.
 *
 * ## False positives
 *
 * Every check is a name or a file comparison — present or absent, never a
 * judgement. The annotation parser binds an annotation to the first
 * string-literal constant after it and drops anything else rather than
 * guessing, so a mis-parse yields "not classified" (loud) and never a wrong
 * class (silent).
 *
 * Usage: npx tsx scripts/check-durable-state-declared.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { scanKindSpecs, unclassifiedKinds } from './lib/parse-records.js'
import {
  buildDurableCatalogue,
  collectSourceFiles,
  buildStorageMap,
  DURABLE_CLASSES,
  type DurableAnnotation,
} from './lib/parse-storage.js'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')
const SETTINGS_BACKEND = path.join(
  ROOT,
  'packages/system/src/builtins/sqlite-storage/sqlite-settings-backend.ts',
)

/**
 * Declared collections that predate the `@durable` annotation.
 *
 * **EMPTY, as of 2026-08-14 — and it stays that way.** It held 44 names; every
 * one is now classified, so the whole domain surface answers "what survives a
 * restart, and who owns it".
 *
 * SHRINK-ONLY. That property is what makes an empty list meaningful rather than
 * decorative: a NEW collection can never appear here, so a new collection has
 * no way to avoid being classified. Re-populating this is not a mechanical
 * edit — it means someone read this comment and decided to reopen a debt that
 * was closed.
 *
 * Worth recording, because the number misled once: the 44 were a CLASSIFICATION
 * debt, not a migration queue. Emptying the list correctly left 39 of the 44 on
 * exactly the mechanism they were already using, and that was the right outcome
 * — most of them are indexed query surfaces or unbounded event tables that must
 * never sit behind a RAM-mirroring primitive. See
 * `docs/design/durable-store-convergence.md` §4.
 */
const BACKLOG: ReadonlySet<string> = new Set([])

/** The files that exist twice and must stay identical. */
const TWINS: readonly { readonly a: string; readonly b: string }[] = [
  {
    a: 'packages/addon-post-analysis/src/durable/durable-ledger.ts',
    b: 'packages/addon-pipeline-orchestrator/src/durable/durable-ledger.ts',
  },
  {
    a: 'packages/addon-post-analysis/src/durable/durable-ledger.ts',
    b: 'packages/addon-pipeline/src/durable/durable-ledger.ts',
  },
]

function annotationProblems(a: DurableAnnotation): readonly string[] {
  const problems: string[] = []
  if (!(DURABLE_CLASSES as readonly string[]).includes(a.semanticClass)) {
    problems.push(`class="${a.semanticClass}" is not one of ${DURABLE_CLASSES.join(' | ')}`)
  }
  if (a.owner === '') problems.push('owner= is missing')
  if (a.writeTrigger === '') problems.push('write="…" is missing')
  if (a.retention === '') problems.push('retention="…" is missing')
  return problems
}

function main(): void {
  const failures: string[] = []

  const map = buildStorageMap(ROOT, SETTINGS_BACKEND)
  const catalogue = buildDurableCatalogue(ROOT)

  // ── 1. classification ───────────────────────────────────────────────
  for (const declared of map.declared) {
    const annotation = catalogue.get(declared.name)
    if (annotation === undefined) {
      if (BACKLOG.has(declared.name)) continue
      failures.push(
        `${declared.file}: collection "${declared.name}" has no @durable annotation.\n` +
          '      → add one to the constant that names it:\n' +
          '        /**\n' +
          '         * @durable class=ledger owner=<addon>\n' +
          '         *   write="what causes a row to be written"\n' +
          '         *   retention="what causes one to go, or why nothing does"\n' +
          '         */\n' +
          `      → classes: ${DURABLE_CLASSES.join(' | ')} (see docs/reference/storage.md §3a)`,
      )
      continue
    }
    for (const problem of annotationProblems(annotation)) {
      failures.push(`${annotation.file}: "${declared.name}" — ${problem}`)
    }
  }

  // The backlog may only shrink.
  const declaredNames = new Set(map.declared.map((d) => d.name))
  for (const name of BACKLOG) {
    if (catalogue.has(name)) {
      failures.push(
        `"${name}" is now classified — delete it from BACKLOG in scripts/check-durable-state-declared.ts.\n` +
          '      → the list is shrink-only precisely so it cannot become a parking space.',
      )
      continue
    }
    if (!declaredNames.has(name)) {
      failures.push(
        `"${name}" is in BACKLOG but is no longer a declared collection — delete the line.`,
      )
    }
  }

  // ── 2. the twins ────────────────────────────────────────────────────
  for (const twin of TWINS) {
    const aPath = path.join(ROOT, twin.a)
    const bPath = path.join(ROOT, twin.b)
    if (!fs.existsSync(aPath) || !fs.existsSync(bPath)) {
      failures.push(`durable primitive missing: ${twin.a} / ${twin.b}`)
      continue
    }
    if (fs.readFileSync(aPath, 'utf-8') !== fs.readFileSync(bPath, 'utf-8')) {
      failures.push(
        `${twin.a} and ${twin.b} have DRIFTED.\n` +
          '      → they are one primitive in two addons (addons never import each other).\n' +
          `      → copy whichever you edited over the other:  cp ${twin.a} ${twin.b}`,
      )
    }
  }

  // ── 3. record kinds (D881) ──────────────────────────────────────────
  // A kind carries its classification in its declaration - `class`, `writeTrigger`
  // and `retention` replace the `@durable` annotation (one authority) - so the
  // declaration must say all three. The runtime schema refuses a missing one when
  // the kind is defined; this finds the omission in the diff.
  const specs = collectSourceFiles(ROOT, ['packages', 'server'])
    .map((abs) => path.relative(ROOT, abs))
    .filter(
      (rel) =>
        rel.endsWith('.ts') &&
        !/(^|\/)(__tests__|dist|assets)\//.test(rel) &&
        !/\.(spec|test)\.ts$/.test(rel),
    )
    .flatMap((rel) => scanKindSpecs(rel, fs.readFileSync(path.join(ROOT, rel), 'utf-8')))
  for (const u of unclassifiedKinds(specs)) {
    failures.push(
      `${u.file}:${u.line}: record kind "${u.kind}" does not declare ${u.missing.join(', ')}.\n` +
        '      → a kind says what class of fact it holds, what writes it and what removes it\n' +
        '        (class, writeTrigger, retention) - the same questions as the @durable annotation.',
    )
  }

  if (failures.length > 0) {
    console.error(`\x1b[31m✘ ${failures.length} durable-state violation(s)\x1b[0m:`)
    for (const f of failures) console.error(`    ${f}`)
    console.error(
      '\n    Why this matters: nothing in this repo answered "what survives a restart,\n' +
        '    and who owns it". Two of the 24 stores the census walked held state nobody\n' +
        '    had decided the class of, and both were live cold-start bugs.',
    )
    process.exit(1)
  }
  console.log(
    `  ✔ durable state: ${catalogue.size} classified, ${BACKLOG.size} on the shrink-only backlog, ${TWINS.length} primitive twins identical, ${specs.length} record kind(s) scanned`,
  )
}

main()
