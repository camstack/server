#!/usr/bin/env tsx
/**
 * Writes the generated skill pointers — the root `AGENTS.md` skills table, the
 * UI blocks, the per-package skill blocks (creating a package's `AGENTS.md` +
 * `CLAUDE.md` (`@AGENTS.md`) where a target asks for it) and one
 * `.cursor/rules/<skill>.mdc` per skill.
 *
 *   npx tsx scripts/skills/gen-skill-pointers.ts          write
 *   npx tsx scripts/skills/gen-skill-pointers.ts --check  fail when any is missing or stale
 *
 * `--check` runs inside `npm run docs:check`. It is a docs check: it verifies
 * that agents are pointed at the procedures — every skill registered, every
 * pointer current, the root AGENTS.md within its share of Codex's 32 KiB cap
 * (an over-long root + package chain is reported, not failed) — never
 * whether the work follows them.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pagePackages } from '../check-addon-page-css.js'
import { codexBudget, planPointers, staleWrites } from './lib/pointer-blocks.js'
import {
  registryProblems,
  SKILLS_BLOCK_HEADING,
  SKILLS_BLOCK_ID,
  SKILLS_TABLE_HEADING,
  SKILLS_TABLE_ID,
  skillAgentsTargets,
  WORKING_STYLE_BLOCK_ID,
  skillMdcTargets,
} from './lib/skill-registry.js'
import { UI_BLOCK_ID, UI_HEADING, uiAgentsTargets, uiMdcTargets } from './lib/ui-pointers.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const GEN = 'npx tsx scripts/skills/gen-skill-pointers.ts'

/** Every AGENTS.md one level under `packages/` and `server/`, plus the root. */
function existingAgentsFiles(root: string): string[] {
  const out = ['AGENTS.md']
  for (const top of ['packages', 'server']) {
    const dir = path.join(root, top)
    if (!fs.existsSync(dir)) continue
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'AGENTS.md'))) {
        out.push(`${top}/${d.name}/AGENTS.md`)
      }
    }
  }
  return out.toSorted()
}

function main(): void {
  const check = process.argv.includes('--check')
  const pages = pagePackages()
  const agents = [...uiAgentsTargets(pages), ...skillAgentsTargets(ROOT, pages)]
  const mdcs = [...uiMdcTargets(ROOT), ...skillMdcTargets()]
  const { writes, problems } = planPointers(ROOT, agents, mdcs, {
    owned: [
      { id: UI_BLOCK_ID, heading: UI_HEADING },
      { id: SKILLS_BLOCK_ID, heading: SKILLS_BLOCK_HEADING },
      { id: SKILLS_TABLE_ID, heading: SKILLS_TABLE_HEADING },
      // It sits under the existing heading: removing it must keep that heading.
      { id: WORKING_STYLE_BLOCK_ID, heading: '' },
    ],
    known: existingAgentsFiles(ROOT),
  })
  const agentsFiles = [
    ...new Set([
      ...existingAgentsFiles(ROOT),
      ...writes.map((w) => w.file).filter((f) => f.endsWith('AGENTS.md')),
    ]),
  ]
  const budget = codexBudget(ROOT, agentsFiles, writes)
  const allProblems = [...problems, ...registryProblems(ROOT), ...budget.errors]
  for (const w of budget.warnings) console.warn(`  ⚠ ${w}`)
  const stale = staleWrites(ROOT, writes)
  if (check) {
    if (stale.length > 0 || allProblems.length > 0) {
      console.error('✘ Skill pointers are missing, stale or wrong:')
      for (const w of stale) console.error(`    stale: ${w.file}`)
      for (const p of allProblems) console.error(`    ${p}`)
      console.error(`\n  Run \`${GEN}\` and commit the result; fix any listed problem by hand.`)
      process.exit(1)
    }
    console.log(`  ✔ ${writes.length} skill pointer file(s) current`)
    return
  }
  for (const w of stale) {
    const abs = path.join(ROOT, w.file)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, w.content)
    console.log(`  wrote ${w.file}`)
  }
  for (const p of allProblems) console.error(`  ✘ ${p}`)
  console.log(`skill pointers: ${writes.length} file(s), ${stale.length} updated`)
  if (allProblems.length > 0) process.exit(1)
}

main()
