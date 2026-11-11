#!/usr/bin/env tsx
/**
 * GUARD: a device card is assembled from the shared parts, never redrawn.
 *
 * Under `packages/ui-library/src/composites/device-card/`:
 *
 *   1. no emoji — a glyph is a `CardGlyph` from `icons.ts`;
 *   2. `lucide-react` is imported by `icons.ts` only;
 *   3. an inline `<svg>` lives in `illustrations/` or `parts/` only — a scene
 *      or the shell composes those;
 *   4. a scene (`scenes/**`) owns no timer: the confirm window is
 *      `ArmedButton`'s and a countdown is `useCountdown`'s, so every card
 *      arms, cancels and counts the same way.
 *
 *   npx tsx scripts/check-device-card-parts.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
export const CARD_DIR = 'packages/ui-library/src/composites/device-card'

export type CardPartRule = 'emoji' | 'lucide-import' | 'inline-svg' | 'scene-timer'

export interface CardPartFinding {
  readonly file: string
  readonly line: number
  readonly rule: CardPartRule
  readonly text: string
}

const EMOJI = /\p{Extended_Pictographic}/u
const LUCIDE = /from\s+['"]lucide-react['"]/
const SVG = /<svg[\s>]/
const TIMER = /\b(setTimeout|setInterval|requestAnimationFrame)\s*\(/

const isTest = (path: string): boolean =>
  path.includes('/__tests__/') || /\.(spec|test)\.tsx?$/.test(path)

/** Findings for one file; `file` is the path RELATIVE to the card directory. */
export function findCardPartProblems(file: string, source: string): CardPartFinding[] {
  if (isTest(`/${file}`)) return []
  const inScene = file.startsWith('scenes/')
  const mayDraw = file.startsWith('illustrations/') || file.startsWith('parts/')
  const findings: CardPartFinding[] = []
  source.split('\n').forEach((text, index) => {
    const push = (rule: CardPartRule): void => {
      findings.push({ file, line: index + 1, rule, text: text.trim() })
    }
    if (EMOJI.test(text)) push('emoji')
    if (file !== 'icons.ts' && LUCIDE.test(text)) push('lucide-import')
    if (!mayDraw && SVG.test(text)) push('inline-svg')
    if (inScene && TIMER.test(text)) push('scene-timer')
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
    findCardPartProblems(relative(base, path), readFileSync(path, 'utf8')),
  )
  if (findings.length > 0) {
    console.error(`check-device-card-parts: ${findings.length} problem(s)`)
    for (const f of findings.slice(0, 40)) {
      console.error(`  - ${CARD_DIR}/${f.file}:${f.line} [${f.rule}] ${f.text.slice(0, 100)}`)
    }
    process.exit(1)
  }
  console.log(
    `check-device-card-parts: ${files.length} file(s) — glyphs from icons.ts, drawings in illustrations/ and parts/, no scene timer`,
  )
}

if (import.meta.url === `file://${process.argv[1]}`) main()
