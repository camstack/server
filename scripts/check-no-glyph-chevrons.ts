#!/usr/bin/env tsx
/**
 * No text-glyph disclosure markers (▸ ▾ ▶ ▼) in UI source.
 *
 * ## The failure this catches
 *
 * Collapsible headers drew their expand / collapse marker as a text glyph at
 * `text-xs` inside a clickable `div` (the Alexa exporter's "Troubleshooting"
 * section, the device-picker groups, the script and automation log toggles).
 * The glyph was too small to read as a control, differed from the lucide
 * chevron `CollapsibleCard` draws, and the `div` header had no button
 * semantics (`aria-expanded`, keyboard).
 *
 * The marker is `DisclosureChevron` (`@camstack/ui-library`), and a header
 * that toggles is a `<button type="button" aria-expanded>`.
 *
 * ## Scope
 *
 * Every `.tsx` under `packages/<pkg>/src`, excluding specs, tests and
 * `__tests__`. Comments are allowed to mention the glyphs; code (string
 * literals and JSX text alike) is not.
 *
 * Usage: npx tsx scripts/check-no-glyph-chevrons.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './check-no-bare-ffmpeg.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const SKIP_DIRS = new Set([
  'dist',
  'node_modules',
  '.git',
  'coverage',
  'generated',
  '__tests__',
  '__mocks__',
  'worktrees',
])
const TSX_RE = /\.tsx$/
const NON_RUNTIME_RE = /\.(?:spec|test)\.tsx$/
const GLYPHS = /[▸▾▶▼]/

export interface GlyphFinding {
  readonly line: number
  readonly text: string
}

/** Lines of `source` whose code (comments removed) holds a disclosure glyph. */
export function findGlyphChevrons(source: string): readonly GlyphFinding[] {
  const code = stripComments(source).split('\n')
  const lines = source.split('\n')
  const findings: GlyphFinding[] = []
  code.forEach((line, index) => {
    if (GLYPHS.test(line)) findings.push({ line: index + 1, text: (lines[index] ?? '').trim() })
  })
  return findings
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = path.join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full, out)
    else if (TSX_RE.test(entry) && !NON_RUNTIME_RE.test(entry)) out.push(full)
  }
}

function uiSourceRoots(): readonly string[] {
  const packagesDir = path.join(ROOT, 'packages')
  return readdirSync(packagesDir)
    .map((name) => path.join(packagesDir, name, 'src'))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory()
      } catch {
        return false
      }
    })
}

function main(): void {
  const files: string[] = []
  for (const root of uiSourceRoots()) walk(root, files)

  const violations: Array<GlyphFinding & { readonly file: string }> = []
  for (const full of files) {
    const file = path.relative(ROOT, full)
    for (const finding of findGlyphChevrons(readFileSync(full, 'utf8'))) {
      violations.push({ ...finding, file })
    }
  }

  if (violations.length === 0) {
    console.log(`check-no-glyph-chevrons: OK (${files.length} .tsx files)`)
    return
  }
  console.error('\n\x1b[31m✘ a text-glyph chevron is drawn in UI source:\x1b[0m')
  console.error(
    '  Use `DisclosureChevron` from @camstack/ui-library, and make a toggling header a\n' +
      '  `<button type="button" aria-expanded>`.\n',
  )
  for (const v of violations) {
    console.error(`    ${v.file}:${v.line}`)
    console.error(`      \x1b[2m${v.text}\x1b[0m`)
  }
  console.error('')
  process.exit(1)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()
