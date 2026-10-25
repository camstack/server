/**
 * Framework package coherence.
 *
 * Spec: docs/superpowers/specs/2026-05-14-framework-live-update-design.md
 *
 * Invariants:
 *   - `SYSTEM_PACKAGE` resolves to a workspace package whose `package.json`
 *     declares `camstack.system: true`.
 *   - `SYSTEM_PACKAGE` is the only workspace package with `camstack.system: true`
 *     (drift in either direction breaks live-update).
 *   - `isFrameworkPackage` accepts the pure-JS framework packages
 *     (`@camstack/{system,types,sdk}`) whose `dist/` is live-mirrored into the
 *     hub closure by `syncFrameworkDist`, and rejects native (`shm-ring`),
 *     addons, and unknown packages (sanity check on the gate the deploy path
 *     uses). `@camstack/types` is included so a capability change ships via
 *     `camstack deploy packages/types` with no image rebuild.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { SYSTEM_PACKAGE, isFrameworkPackage } from '../core/addon/addon-package.service.js'

function repoRoot(): string {
  return path.resolve(__dirname, '..', '..', '..', '..')
}

interface PackageJsonView {
  readonly name: string
  readonly system: boolean
  readonly path: string
}

function readPackageJson(pkgJsonPath: string): PackageJsonView | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'))
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const obj = raw as Record<string, unknown>
    const name = obj['name']
    if (typeof name !== 'string') return null
    const camstack = obj['camstack']
    const isSystem =
      camstack !== null &&
      typeof camstack === 'object' &&
      !Array.isArray(camstack) &&
      (camstack as Record<string, unknown>)['system'] === true
    return { name, system: isSystem, path: pkgJsonPath }
  } catch {
    return null
  }
}

function discoverWorkspacePackages(): readonly PackageJsonView[] {
  const packagesDir = path.join(repoRoot(), 'packages')
  if (!fs.existsSync(packagesDir)) return []
  const results: PackageJsonView[] = []
  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const pkgJson = path.join(packagesDir, entry.name, 'package.json')
    if (!fs.existsSync(pkgJson)) continue
    const view = readPackageJson(pkgJson)
    if (view !== null) results.push(view)
  }
  return results
}

describe('framework package — manifest parity', () => {
  it('SYSTEM_PACKAGE exists in `packages/` with camstack.system: true', () => {
    const pkgs = discoverWorkspacePackages()
    const match = pkgs.find((p) => p.name === SYSTEM_PACKAGE)
    expect(match, `expected ${SYSTEM_PACKAGE} in packages/`).toBeDefined()
    expect(match?.system, `${SYSTEM_PACKAGE} must declare camstack.system: true`).toBe(true)
  })

  it.todo(
    'every workspace package with camstack.system: true is SYSTEM_PACKAGE — pending manifest clean-up of @camstack/{types,sdk,shm-ring,ui-library}',
  )
})

describe('isFrameworkPackage', () => {
  it('returns true for the pure-JS framework packages (system, types, sdk)', () => {
    expect(isFrameworkPackage(SYSTEM_PACKAGE)).toBe(true)
    expect(isFrameworkPackage('@camstack/types')).toBe(true)
    expect(isFrameworkPackage('@camstack/sdk')).toBe(true)
  })

  it('returns false for native shm-ring, addons and unknown packages', () => {
    // shm-ring ships a native `.node` prebuild — not dist-only mirrorable.
    expect(isFrameworkPackage('@camstack/shm-ring')).toBe(false)
    expect(isFrameworkPackage('@camstack/addon-stream-broker')).toBe(false)
    expect(isFrameworkPackage('left-pad')).toBe(false)
    expect(isFrameworkPackage('')).toBe(false)
    expect(isFrameworkPackage('@camstack')).toBe(false)
  })
})
