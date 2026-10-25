#!/usr/bin/env tsx
/**
 * Viewer-link guard — **`buildViewerLink` (`@camstack/types`
 * `viewer-link-url.ts`) is the only place a link to a VIEWER page, or to the
 * CamStack app link domain, is assembled.** (D709)
 *
 * ## The failure this catches
 *
 * The address a notification tap opens is an operator choice (the address
 * flagged for notifications on the admin Network page). By default it is the
 * CamStack app link, `https://camstack.zentik.app/<viewer path>?…&hub=`; the
 * operator can flag one of the hub's own addresses instead, and then the tap
 * is `<base>/viewer/camstack/<viewer path>`. Both forms, the AASA-claimed
 * route families and the `hub=` encoding live in one builder, and the Network
 * page previews through it. A second hand-written
 * `${base}/viewer/camstack/camera/${id}` in the notification centre would
 * keep minting the hub form after the operator picked the app link — the
 * phone would open a browser instead of the app, and the preview the operator
 * checked would say otherwise.
 *
 * ## What it checks
 *
 *   1. No string or template literal containing `camstack.zentik.app` in
 *      `packages/` source outside the builder (comments are fine).
 *   2. No string or template literal containing `/viewer/camstack` in the
 *      notification centre (`packages/addon-post-analysis/src`) — every
 *      viewer destination it links to goes through the builder.
 *
 * Tests, `dist` and generated code are skipped.
 *
 * Usage: tsx scripts/check-viewer-link-builder-is-the-only-source.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

const BUILDER = 'packages/types/src/capabilities/viewer-link-url.ts'
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  'coverage',
  'worktrees',
  '__tests__',
  'generated',
])

const APP_LINK_LITERAL = /(['"`])[^'"`\n]*camstack\.zentik\.app/
const VIEWER_MOUNT_LITERAL = /(['"`])[^'"`\n]*\/viewer\/camstack/

interface Rule {
  readonly scope: string
  readonly pattern: RegExp
  readonly what: string
}

const RULES: readonly Rule[] = [
  { scope: 'packages', pattern: APP_LINK_LITERAL, what: 'assembles the app link domain' },
  {
    scope: 'packages/addon-post-analysis/src',
    pattern: VIEWER_MOUNT_LITERAL,
    what: 'assembles a hub viewer URL',
  },
]

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(path.join(dir, entry.name), out)
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue
    if (/\.(spec|test)\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue
    out.push(path.join(dir, entry.name))
  }
}

/** A line that is only comment — prose may name the domain. */
function isCommentLine(line: string): boolean {
  const t = line.trim()
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')
}

function main(): void {
  const problems: string[] = []
  for (const rule of RULES) {
    const files: string[] = []
    walk(path.join(ROOT, rule.scope), files)
    for (const file of files) {
      const rel = path.relative(ROOT, file)
      if (rel === BUILDER) continue
      const lines = fs.readFileSync(file, 'utf8').split('\n')
      for (const [i, line] of lines.entries()) {
        if (isCommentLine(line)) continue
        if (rule.pattern.test(line)) {
          problems.push(`${rel}:${String(i + 1)} ${rule.what}: ${line.trim()}`)
        }
      }
    }
  }
  if (problems.length > 0) {
    console.error('Viewer links are built only by buildViewerLink (@camstack/types, D709):')
    for (const p of problems) console.error(`  ${p}`)
    console.error(
      'Use buildViewerLink / CAMSTACK_APP_LINK_ORIGIN / HUB_VIEWER_MOUNT from @camstack/types.',
    )
    process.exit(1)
  }
  console.log('viewer-link builder guard: ok')
}

main()
