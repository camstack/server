#!/usr/bin/env tsx
/**
 * Write the derived part of every package README (and seed a README, a
 * CHANGELOG with a first real entry, and the `files` entries a published
 * package needs).
 *
 *   npm run readme:generate              # every package
 *   npm run readme:generate -- addon-ai  # one package
 *
 * Hand-written text outside the generated markers is never changed.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { firstRelease, isStub } from './lib/changelog'
import { applyGenerated, friendlyName, renderGenerated } from './lib/readme-docs'
import { readWorkspacePackages, resolvePackage, type WorkspacePackage } from './lib/workspace-packages'

const ROOT = path.resolve(import.meta.dirname, '..')
const TODAY = '2026-10-27'

function firstEntries(pkg: WorkspacePackage): readonly string[] {
  const camstack = pkg.manifest['camstack']
  const addons =
    camstack !== null && typeof camstack === 'object' && 'addons' in camstack && Array.isArray(camstack.addons)
      ? camstack.addons
      : []
  const lines = [
    pkg.description.length > 0
      ? `${friendlyName(pkg)}: ${pkg.description.replace(/\.$/, '')}.`
      : `${friendlyName(pkg)} (${pkg.name}).`,
  ]
  const names = addons
    .map((addon: unknown) =>
      addon !== null && typeof addon === 'object' && 'name' in addon && typeof addon.name === 'string'
        ? addon.name
        : '',
    )
    .filter(Boolean)
  if (names.length > 0) lines.push(`Provides the addon${names.length > 1 ? 's' : ''} ${names.join(', ')}.`)
  return lines
}

/** A published package packs its README and CHANGELOG: add them to `files`. */
function ensureFiles(root: string, pkg: WorkspacePackage): boolean {
  const files = pkg.manifest['files']
  if (!Array.isArray(files)) return false
  const missing = ['README.md', 'CHANGELOG.md'].filter((name) => !files.includes(name))
  if (missing.length === 0) return false
  const next = { ...pkg.manifest, files: [...files, ...missing] }
  fs.writeFileSync(path.join(root, pkg.dir, 'package.json'), `${JSON.stringify(next, null, 2)}\n`)
  return true
}

export function generateFor(root: string, pkg: WorkspacePackage): readonly string[] {
  const written: string[] = []
  const readme = path.join(root, pkg.dir, 'README.md')
  const current = fs.existsSync(readme) ? fs.readFileSync(readme, 'utf8') : null
  const next = applyGenerated(current, pkg, renderGenerated(root, pkg))
  if (next !== current) {
    fs.writeFileSync(readme, next)
    written.push(`${pkg.dir}/README.md`)
  }
  const changelog = path.join(root, pkg.dir, 'CHANGELOG.md')
  const log = fs.existsSync(changelog) ? fs.readFileSync(changelog, 'utf8') : ''
  if (isStub(log)) {
    fs.writeFileSync(changelog, firstRelease(pkg.version, TODAY, firstEntries(pkg)))
    written.push(`${pkg.dir}/CHANGELOG.md`)
  }
  if (!pkg.isPrivate && ensureFiles(root, pkg)) written.push(`${pkg.dir}/package.json`)
  return written
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  const packages = readWorkspacePackages(ROOT)
  const query = process.argv[2]
  const targets = query === undefined ? packages : [resolvePackage(packages, query)].filter((p) => p !== null)
  let count = 0
  for (const pkg of targets) {
    for (const file of generateFor(ROOT, pkg)) {
      console.log(`readme:generate: ${file}`)
      count += 1
    }
  }
  console.log(`readme:generate: ${count} file(s) written`)
}
