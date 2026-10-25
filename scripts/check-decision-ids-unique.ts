#!/usr/bin/env tsx
/**
 * Decision-id guard — two records may never claim the same `D<n>`.
 *
 * ## The failure that produced this
 *
 * On 2026-08-15 two sessions worked in parallel worktrees. Each read
 * `docs/decisions/`, saw D167 as the highest, and took **D168**. Different
 * filenames, so git merged both without a whisper of conflict; the generated
 * `docs/decisions/index.md` simply listed D168 twice. Nothing in the repo
 * noticed — not codegen, not `docs:check`, not review — and every future
 * reference to "D168" would have been ambiguous forever, in a repo whose entire
 * rule system is cross-referenced by these ids.
 *
 * "Take the next free number" is a race between agents, and the index is
 * GENERATED from the frontmatter, so the generator will happily render the
 * collision rather than reject it. That is exactly the shape a guard exists
 * for: a convention nothing checks has already been broken somewhere.
 *
 * Also caught here, because they are the same class of silent-wrong:
 *   - a record whose `id` does not match its FILENAME (`adr-0168-*.md` must
 *     declare `id: D168`), which would make the file unfindable from a
 *     reference;
 *   - a missing or malformed `id`.
 *
 * Usage:
 *   npx tsx scripts/check-decision-ids-unique.ts
 */
import { readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const DECISIONS = path.join(ROOT, 'docs', 'decisions')
/** Not records: the index is generated, the other two are scaffolding. */
const NOT_A_DECISION = new Set(['index.md', 'conventions.md', 'template.md'])

interface Record {
  readonly file: string
  readonly id: string
}

function frontmatterId(source: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)
  if (match === null) return null
  const idLine = /^id:\s*(\S+)\s*$/m.exec(String(match[1]))
  return idLine === null ? null : String(idLine[1])
}

/** `adr-0168-a-slug.md` → `D168`; `adr-0149.md` → `D149`. */
function idFromFilename(file: string): string | null {
  const match = /^adr-(\d{4})(?:-.*)?\.md$/.exec(file)
  return match === null ? null : `D${String(Number(match[1]))}`
}

function main(): void {
  const files = readdirSync(DECISIONS)
    .filter((f) => f.endsWith('.md'))
    .filter((f) => !NOT_A_DECISION.has(f))
    .toSorted()

  const problems: string[] = []
  const records: Record[] = []

  for (const file of files) {
    const id = frontmatterId(readFileSync(path.join(DECISIONS, file), 'utf8'))
    if (id === null || !/^D\d+$/.test(id)) {
      problems.push(`${file} — frontmatter has no valid \`id: D<n>\` (found ${String(id)})`)
      continue
    }
    const expected = idFromFilename(file)
    if (expected !== null && expected !== id) {
      problems.push(`${file} — declares \`id: ${id}\` but its filename says ${expected}`)
    }
    records.push({ file, id })
  }

  const byId = new Map<string, string[]>()
  for (const record of records) {
    byId.set(record.id, [...(byId.get(record.id) ?? []), record.file])
  }
  for (const [id, owners] of [...byId.entries()].toSorted()) {
    if (owners.length > 1) {
      problems.push(
        `${id} is claimed by ${String(owners.length)} records: ${owners.join(', ')} — ` +
          `the one that is NOT yet on origin/main must take the next free number`,
      )
    }
  }

  if (problems.length > 0) {
    console.error(`[31m✘ ${String(problems.length)} decision-id problem(s)[0m:`)
    for (const problem of problems) console.error(`    ${problem}`)
    process.exit(1)
  }

  const highest = Math.max(...records.map((r) => Number(r.id.slice(1))))
  console.log(
    `[32m✔[0m ${String(records.length)} decision records, ids unique (highest D${String(highest)})`,
  )
}

main()
