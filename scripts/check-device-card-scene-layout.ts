#!/usr/bin/env tsx
/**
 * GUARD: every device-card scene sits on the one fixed layout.
 *
 * Under `packages/ui-library/src/composites/device-card/`:
 *
 *   1. the free layout is gone: no `FreeSceneZones`, no `data-columns`;
 *   2. a scene gives `scene={{ … }}` a `columns: { left, right }` of
 *      `ColumnItem[]` — a side given a JSX node (`left: <X/>`, `right: (`) is
 *      the old free zone and is refused;
 *   3. a `ColumnItem` is built by the `column*` factories of
 *      `shell/column-items.tsx` only — never `new ColumnItem(` elsewhere;
 *   4. the column width is `SCENE_COLUMN_PCT`: `card-css.ts` takes it from
 *      `scene-layout.ts`, and no other file spells a `grid-template-columns`
 *      percentage of its own.
 *
 *   npx tsx scripts/check-device-card-scene-layout.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
export const CARD_DIR = 'packages/ui-library/src/composites/device-card'

export type SceneLayoutRule =
  | 'free-layout'
  | 'free-zone-node'
  | 'column-item-by-hand'
  | 'column-percentage'

export interface SceneLayoutFinding {
  readonly file: string
  readonly line: number
  readonly rule: SceneLayoutRule
  readonly text: string
}

const FREE_LAYOUT = /FreeSceneZones|data-columns/
const FREE_ZONE_NODE = /^\s*(left|right)\s*:\s*[<(]/
const COLUMN_ITEM_NEW = /new\s+ColumnItem\s*\(/
const PERCENT_GRID = /grid-template-columns\s*:\s*[\d.]+%/

const isTest = (path: string): boolean =>
  path.includes('/__tests__/') || /\.(spec|test)\.tsx?$/.test(path)

/** Findings for one file; `file` is the path RELATIVE to the card directory. */
export function findSceneLayoutProblems(file: string, source: string): SceneLayoutFinding[] {
  if (isTest(`/${file}`)) return []
  const inScene = file.startsWith('scenes/')
  const findings: SceneLayoutFinding[] = []
  source.split('\n').forEach((text, index) => {
    const push = (rule: SceneLayoutRule): void => {
      findings.push({ file, line: index + 1, rule, text: text.trim() })
    }
    if (FREE_LAYOUT.test(text)) push('free-layout')
    if (inScene && FREE_ZONE_NODE.test(text)) push('free-zone-node')
    if (file !== 'shell/column-items.tsx' && COLUMN_ITEM_NEW.test(text)) push('column-item-by-hand')
    if (PERCENT_GRID.test(text)) push('column-percentage')
  })
  return findings
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return walk(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

function main(): void {
  const base = join(ROOT, CARD_DIR)
  const files = walk(base)
  const findings = files.flatMap((path) =>
    findSceneLayoutProblems(relative(base, path), readFileSync(path, 'utf8')),
  )
  if (findings.length > 0) {
    console.error(`check-device-card-scene-layout: ${findings.length} problem(s)`)
    for (const f of findings.slice(0, 40)) {
      console.error(`  - ${CARD_DIR}/${f.file}:${f.line} [${f.rule}] ${f.text.slice(0, 100)}`)
    }
    process.exit(1)
  }
  console.log(
    `check-device-card-scene-layout: ${files.length} file(s) — one fixed layout, columns hold column items only`,
  )
}

if (import.meta.url === `file://${process.argv[1]}`) main()
