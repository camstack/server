import * as fs from 'node:fs'
import * as path from 'node:path'
import { asRecord, readJsonFile, resolveWorkspacePaths } from '../workspace.js'
import type { AddonCapabilityRef, AddonManifestEntry, AddonPackageSummary } from '../types.js'

function parseCapabilities(raw: unknown): readonly AddonCapabilityRef[] {
  if (!Array.isArray(raw)) return []
  const out: AddonCapabilityRef[] = []
  for (const item of raw) {
    const rec = asRecord(item)
    if (!rec) continue
    const name = rec['name']
    if (typeof name === 'string' && name.length > 0) out.push({ name })
  }
  return out
}

function parseAddonEntry(raw: unknown): AddonManifestEntry | null {
  const rec = asRecord(raw)
  if (!rec) return null
  const id = typeof rec['id'] === 'string' ? rec['id'] : null
  const name = typeof rec['name'] === 'string' ? rec['name'] : id
  const entry = typeof rec['entry'] === 'string' ? rec['entry'] : null
  if (!id || !name || !entry) return null
  const description = typeof rec['description'] === 'string' ? rec['description'] : ''
  const category = typeof rec['category'] === 'string' ? rec['category'] : undefined
  const execution = asRecord(rec['execution'])
  const placement =
    execution && typeof execution['placement'] === 'string' ? execution['placement'] : undefined
  const group = execution && typeof execution['group'] === 'string' ? execution['group'] : undefined
  return {
    id,
    name,
    description,
    entry,
    ...(category ? { category } : {}),
    capabilities: parseCapabilities(rec['capabilities']),
    ...(placement ? { placement } : {}),
    ...(group ? { group } : {}),
  }
}

function summarizePackage(pkgDir: string, workspaceRoot: string): AddonPackageSummary | null {
  const pkg = readJsonFile(path.join(pkgDir, 'package.json'))
  if (!pkg) return null
  const camstack = asRecord(pkg['camstack'])
  if (!camstack) return null
  const addonsRaw = camstack['addons']
  if (!Array.isArray(addonsRaw) || addonsRaw.length === 0) return null

  const addons: AddonManifestEntry[] = []
  for (const raw of addonsRaw) {
    const entry = parseAddonEntry(raw)
    if (entry) addons.push(entry)
  }
  if (addons.length === 0) return null

  const packageName = typeof pkg['name'] === 'string' ? pkg['name'] : path.basename(pkgDir)
  const displayName =
    typeof camstack['displayName'] === 'string' ? camstack['displayName'] : undefined
  const description =
    typeof pkg['description'] === 'string'
      ? pkg['description']
      : typeof camstack['description'] === 'string'
        ? camstack['description']
        : undefined

  return {
    packageName,
    packageDir: pkgDir,
    relativeDir: path.relative(workspaceRoot, pkgDir),
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
    addons,
  }
}

/** Every workspace package that declares `camstack.addons[]`. */
export function listAddonPackages(workspaceRoot: string): readonly AddonPackageSummary[] {
  const { packagesDir } = resolveWorkspacePaths(workspaceRoot)
  if (!fs.existsSync(packagesDir)) return []
  const out: AddonPackageSummary[] = []
  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const summary = summarizePackage(path.join(packagesDir, entry.name), workspaceRoot)
    if (summary) out.push(summary)
  }
  // Builtins live under packages/system — surface them as one synthetic package
  // when the system package declares addons (it does).
  return out.toSorted((a, b) => a.packageName.localeCompare(b.packageName))
}

export function findAddonPackage(workspaceRoot: string, query: string): AddonPackageSummary | null {
  const q = query.trim().toLowerCase()
  const all = listAddonPackages(workspaceRoot)
  for (const pkg of all) {
    if (pkg.packageName.toLowerCase() === q) return pkg
    if (pkg.relativeDir.toLowerCase() === q) return pkg
    if (path.basename(pkg.packageDir).toLowerCase() === q) return pkg
    if (path.basename(pkg.packageDir).toLowerCase() === `addon-${q}`) return pkg
    for (const addon of pkg.addons) {
      if (addon.id.toLowerCase() === q) return pkg
      if (addon.name.toLowerCase() === q) return pkg
    }
  }
  // Absolute / relative path
  const abs = path.resolve(workspaceRoot, query)
  if (fs.existsSync(path.join(abs, 'package.json'))) {
    return summarizePackage(abs, workspaceRoot)
  }
  return null
}

/** Flat list of (package, addon) for who_provides. */
export function whoProvides(
  workspaceRoot: string,
  capName: string,
): readonly { package: AddonPackageSummary; addon: AddonManifestEntry }[] {
  const needle = capName.trim().toLowerCase()
  const hits: { package: AddonPackageSummary; addon: AddonManifestEntry }[] = []
  for (const pkg of listAddonPackages(workspaceRoot)) {
    for (const addon of pkg.addons) {
      if (addon.capabilities.some((c) => c.name.toLowerCase() === needle)) {
        hits.push({ package: pkg, addon })
      }
    }
  }
  return hits
}
