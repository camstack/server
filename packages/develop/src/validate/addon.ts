import * as fs from 'node:fs'
import * as path from 'node:path'
import { findAddonPackage } from '../catalogue/addons.js'
import { listCapabilities } from '../catalogue/capabilities.js'
import { asRecord, readJsonFile } from '../workspace.js'
import { checkAddonEntries } from './entries.js'
import type { ValidationFinding, ValidationResult } from '../types.js'

/**
 * Validate one addon package (or the whole workspace when query omitted).
 * Combines manifest shape checks with the vite-entries guard. Does not
 * open SQLite, call a hub, or run codegen.
 */
export function validateAddon(workspaceRoot: string, query?: string): ValidationResult {
  const findings: ValidationFinding[] = []

  if (query === undefined || query.trim() === '' || query === '--all') {
    findings.push(...checkAddonEntries(workspaceRoot).findings)
    return { ok: findings.every((f) => f.level !== 'error'), findings }
  }

  const pkg = findAddonPackage(workspaceRoot, query)
  if (!pkg) {
    return {
      ok: false,
      findings: [
        {
          level: 'error',
          code: 'not-found',
          message: `No addon package matched: ${query}`,
        },
      ],
    }
  }

  findings.push(...checkManifestShape(pkg.packageDir, pkg.packageName))
  findings.push(...checkDeclaredCapsExist(workspaceRoot, pkg.packageDir, pkg.packageName))
  findings.push(...checkAddonEntries(workspaceRoot, pkg.packageDir).findings)

  return {
    ok: findings.every((f) => f.level !== 'error'),
    findings,
  }
}

function checkManifestShape(pkgDir: string, pkgName: string): readonly ValidationFinding[] {
  const findings: ValidationFinding[] = []
  const pkg = readJsonFile(path.join(pkgDir, 'package.json'))
  if (!pkg) {
    return [
      {
        level: 'error',
        code: 'no-package-json',
        message: `${pkgName}: missing package.json`,
        path: pkgDir,
      },
    ]
  }
  const camstack = asRecord(pkg['camstack'])
  const addons = camstack?.['addons']
  if (!Array.isArray(addons) || addons.length === 0) {
    findings.push({
      level: 'error',
      code: 'no-addons',
      message: `${pkgName}: camstack.addons[] is empty or missing`,
      path: path.join(pkgDir, 'package.json'),
    })
    return findings
  }
  for (const raw of addons) {
    const addon = asRecord(raw)
    if (!addon) continue
    const id = typeof addon['id'] === 'string' ? addon['id'] : '(unnamed)'
    if (typeof addon['description'] !== 'string' || addon['description'].trim() === '') {
      findings.push({
        level: 'warn',
        code: 'missing-description',
        message: `${pkgName} → ${id}: description missing (Admin UI + docs show "—")`,
        path: path.join(pkgDir, 'package.json'),
      })
    }
    if (!fs.existsSync(path.join(pkgDir, 'vite.config.ts'))) {
      findings.push({
        level: 'warn',
        code: 'no-vite-config',
        message: `${pkgName}: no vite.config.ts — entry may not be built`,
        path: pkgDir,
      })
    }
  }
  return findings
}

function checkDeclaredCapsExist(
  workspaceRoot: string,
  pkgDir: string,
  pkgName: string,
): readonly ValidationFinding[] {
  const known = new Set(listCapabilities(workspaceRoot).map((c) => c.name))
  const pkg = readJsonFile(path.join(pkgDir, 'package.json'))
  const camstack = asRecord(pkg?.['camstack'])
  const addons = camstack?.['addons']
  if (!Array.isArray(addons)) return []

  const findings: ValidationFinding[] = []
  for (const raw of addons) {
    const addon = asRecord(raw)
    if (!addon) continue
    const id = typeof addon['id'] === 'string' ? addon['id'] : '(unnamed)'
    const caps = addon['capabilities']
    if (!Array.isArray(caps)) continue
    for (const cap of caps) {
      const rec = asRecord(cap)
      const name = rec && typeof rec['name'] === 'string' ? rec['name'] : null
      if (!name) continue
      if (!known.has(name)) {
        findings.push({
          level: 'error',
          code: 'unknown-capability',
          message: `${pkgName} → ${id}: declares unknown capability \`${name}\``,
          path: path.join(pkgDir, 'package.json'),
        })
      }
    }
  }
  return findings
}
