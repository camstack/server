#!/usr/bin/env tsx
/**
 * The derived block of every package README matches what the manifest, the
 * settings labels and the docs frontmatter say today. A stale block lists a
 * capability the package no longer provides or a doc that moved.
 *
 * Fix: `npm run readme:generate` (hand-written text is never touched).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { applyGenerated, renderGenerated } from './lib/readme-docs'
import { readWorkspacePackages } from './lib/workspace-packages'

const ROOT = path.resolve(import.meta.dirname, '..')

export function staleReadmes(root: string): readonly string[] {
  const stale: string[] = []
  for (const pkg of readWorkspacePackages(root)) {
    const file = path.join(root, pkg.dir, 'README.md')
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
    if (current === null || applyGenerated(current, pkg, renderGenerated(root, pkg)) !== current) {
      stale.push(pkg.dir)
    }
  }
  return stale
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  const stale = staleReadmes(ROOT)
  if (stale.length > 0) {
    console.error(`✖ package READMEs: ${stale.length} stale or missing — run npm run readme:generate`)
    for (const dir of stale) console.error(`  ${dir}`)
    process.exit(1)
  }
  console.log('✔ package READMEs: derived blocks are current')
}
