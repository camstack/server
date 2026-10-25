/**
 * AddonInstaller.REQUIRED_PACKAGES — coherence invariants.
 *
 * The list now serves a single purpose: BOOTSTRAP-INSTALL on first
 * boot. Runtime uninstall protection has moved to manifest-driven
 * flags (`camstack.addons[N].protected: true`); see
 * `AddonRegistryService.isPackageProtected()`. The cross-check
 * between the two systems is enforced by the third test below.
 *
 * Two invariants on the bootstrap list:
 *   1. Every name in `AddonInstaller.REQUIRED_PACKAGES` resolves to a
 *      workspace package in `packages/` — no dangling entries.
 *   2. Every `@camstack/addon-*` listed in `server/backend/package.json`
 *      (the backend's declared runtime dependencies) MUST appear in
 *      REQUIRED_PACKAGES — if the backend depends on it, the install
 *      seed has to include it.
 *
 * Plus one invariant on protection:
 *   3. Every package in REQUIRED_PACKAGES MUST also have at least one
 *      addon manifest entry with `protected: true`. Without this, a
 *      bootstrap-required package could be runtime-uninstalled and
 *      the cluster would lose a critical capability.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AddonInstaller } from '../addon-installer.js'

function repoRoot(): string {
  // this file lives at packages/system/src/kernel/__tests__/… — five ../ up
  return path.resolve(__dirname, '..', '..', '..', '..', '..')
}

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T
}

interface PackageJson {
  readonly name?: string
  readonly keywords?: readonly string[]
  readonly dependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly camstack?: {
    readonly agentOnlyBootstrapAddons?: readonly string[]
    readonly agentBootstrapAddons?: readonly string[]
  }
}

function listWorkspacePackages(): Array<{
  name: string
  dir: string
  keywords: readonly string[]
}> {
  const packagesDir = path.join(repoRoot(), 'packages')
  const out: Array<{ name: string; dir: string; keywords: readonly string[] }> = []
  for (const entry of fs.readdirSync(packagesDir)) {
    const dir = path.join(packagesDir, entry)
    const pkgJsonPath = path.join(dir, 'package.json')
    if (!fs.existsSync(pkgJsonPath)) continue
    const pkg = readJson<PackageJson>(pkgJsonPath)
    if (!pkg.name) continue
    out.push({ name: pkg.name, dir, keywords: pkg.keywords ?? [] })
  }
  return out
}

function backendPackage(): PackageJson {
  return readJson<PackageJson>(path.join(repoRoot(), 'server', 'backend', 'package.json'))
}

function listBackendAddonDeps(): readonly string[] {
  const backend = backendPackage()
  const all = {
    ...backend.dependencies,
    ...backend.peerDependencies,
  }
  // Agent-only bootstrap addons (carried in the closure for agent-role seeding
  // only, e.g. @camstack/addon-agent-ui) are excluded from the HUB bootstrap
  // set — mirror `AddonInstaller.deriveBootstrapList`'s exclusion here.
  const agentOnly = new Set(backend.camstack?.agentOnlyBootstrapAddons ?? [])
  return Object.keys(all).filter((n) => n.startsWith('@camstack/addon-') && !agentOnly.has(n))
}

interface CamstackAddonEntry {
  readonly id?: string
  readonly protected?: boolean
}

function packageHasProtectedAddon(packageDir: string): boolean {
  const pkgJsonPath = path.join(packageDir, 'package.json')
  if (!fs.existsSync(pkgJsonPath)) return false
  const raw = readJson<{ camstack?: { addons?: readonly CamstackAddonEntry[] } }>(pkgJsonPath)
  const addons = raw.camstack?.addons ?? []
  return addons.some((a) => a.protected === true)
}

describe('AddonInstaller.REQUIRED_PACKAGES coherence', () => {
  const workspacePackages = listWorkspacePackages()

  it('every entry in REQUIRED_PACKAGES resolves to a workspace package directory', () => {
    const missing: string[] = []
    for (const required of AddonInstaller.REQUIRED_PACKAGES) {
      const match = workspacePackages.find((p) => p.name === required)
      if (!match) missing.push(required)
    }
    expect(missing).toEqual([])
  })

  it('REQUIRED_PACKAGES is the set of @camstack/addon-* deps in server/backend/package.json plus @camstack/system', () => {
    const required = [...AddonInstaller.REQUIRED_PACKAGES].toSorted()
    // The bootstrap set is every @camstack/addon-* dep PLUS @camstack/system —
    // the framework core builtins the kernel installs at boot (see
    // addon-installer.ts: `deps.filter(n => n.startsWith('@camstack/addon-') ||
    // n === '@camstack/system')`). The single source of truth is the backend's
    // package.json deps; this guard keeps REQUIRED_PACKAGES in lockstep.
    const expected = [...listBackendAddonDeps(), '@camstack/system'].toSorted()
    expect(required).toEqual(expected)
  })

  it('every package in REQUIRED_PACKAGES has at least one addon manifest entry with protected: true', () => {
    const missing: string[] = []
    for (const required of AddonInstaller.REQUIRED_PACKAGES) {
      const match = workspacePackages.find((p) => p.name === required)
      if (!match) continue // covered by invariant #1
      if (!packageHasProtectedAddon(match.dir)) missing.push(required)
    }
    // A bootstrap-required package without a protected addon can be
    // runtime-uninstalled, which strips the capability the kernel
    // assumed always present. Keep the manifest flags in lockstep
    // with the bootstrap list — same drift class as the legacy
    // REQUIRED_PACKAGE_NAMES test guarded.
    expect(missing).toEqual([])
  })

  it('AGENT_PACKAGES is exactly server/backend package.json camstack.agentBootstrapAddons plus @camstack/system', () => {
    // Post-consolidation the agent boots the SAME `@camstack/server` closure,
    // so its bootstrap set is the backend manifest's `agentBootstrapAddons`
    // field (single source of truth — the separate agent meta-package is gone).
    const agentBootstrapAddons = backendPackage().camstack?.agentBootstrapAddons ?? []
    const agent = [...AddonInstaller.AGENT_PACKAGES].toSorted()
    // Same bootstrap contract as the hub: the declared addons PLUS @camstack/system.
    const expected = [...agentBootstrapAddons, '@camstack/system'].toSorted()
    expect(agent).toEqual(expected)
  })
})
