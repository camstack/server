/**
 * Boot-time inventory of RIVAL ADDON ROOTS — the addon-shaped companion to
 * `package-inventory.ts` (D45).
 *
 * WHAT THE OTHER ONE CANNOT SEE
 * `package-inventory.ts` answers "how many copies of `@camstack/system` exist
 * under the roots this node resolves through". Every root it scans is derived
 * from the ACTIVE data dir, so a whole second data root — a different
 * `<dataDir>` with its own `addons/@camstack/` tree, belonging to a retired
 * app id or an abandoned layout — is structurally invisible to it. Yet that is
 * the copy people actually read versions out of, because it is a plausible
 * path with plausible package.json files in it.
 *
 * MEASURED, 2026-08-07
 * The Mac agent node has FOUR addon roots on one disk:
 *
 *   ~/Library/Application Support/@camstack/desktop/data/addons/@camstack
 *       — LIVE (addon-pipeline 1.2.43, deployed that afternoon)
 *   ~/camstack-agent-data/addons/@camstack
 *       — abandoned 2026-06-28, addon-pipeline 1.1.1
 *   ~/Library/Application Support/@camstack/electron-agent/agent-data/addons/@camstack
 *       — abandoned 2026-07-20, addon-pipeline 1.1.70
 *   ~/Library/Application Support/@camstack/electron/data/addons/@camstack
 *       — abandoned 2026-07-17, addon-pipeline 1.1.59
 *
 * Four truthful answers to "what version of addon-pipeline is on the Mac", one
 * of which is about the running node. An hour was spent on the wrong one.
 *
 * WHAT THIS IS NOT
 * It is not a filesystem walk and it does not delete anything. It stats a
 * bounded, explicit candidate list and prints what it finds, once, at boot —
 * the same policy as D45: make a second install location LOUD instead of
 * letting it coexist silently. Removal stays an operator decision.
 *
 * Pure by construction: the caller injects every filesystem operation, so the
 * whole thing is asserted against a described layout rather than a real disk.
 */
import * as path from 'node:path'

/** The one directory under a data root that holds installed addons. */
export const ADDONS_SUBDIR = 'addons'
/** The scope every first-party addon package sits under. */
export const ADDON_SCOPE = '@camstack'

export interface RivalRootInput {
  /** The data root this node is ACTUALLY running from (`CAMSTACK_DATA`). */
  readonly dataDir: string
  /** The addon root this node resolved — `CAMSTACK_ADDONS_DIR` or its default. */
  readonly activeAddonsDir: string
  /** `os.homedir()`. Empty string when unavailable. */
  readonly homeDir: string
  readonly platform: NodeJS.Platform
}

/**
 * Data roots a camstack node has ever been configured to use on this machine.
 *
 * Enumerated, not searched. Each entry is a layout this project has actually
 * shipped, so the list documents its own history:
 *   - `~/camstack-agent-data` — the pre-Electron agent's data root.
 *   - `<appSupport>/@camstack/<appId>/data` — every Electron app id the product
 *     has carried (`electron`, `electron-agent`, `desktop`). The rename left the
 *     old ids' trees behind, each a complete addon install.
 *   - `<appSupport>/@camstack/electron-agent/agent-data` — the one app id that
 *     used a different subdir name.
 *
 * A new app id must be ADDED here when it ships, and an id must never be
 * removed when it is retired — a retired id is exactly what this looks for.
 */
export const KNOWN_ELECTRON_APP_IDS: readonly string[] = ['electron', 'electron-agent', 'desktop']

export function candidateDataRoots(input: RivalRootInput): readonly string[] {
  if (input.homeDir.length === 0) return []
  const appSupport =
    input.platform === 'darwin'
      ? path.join(input.homeDir, 'Library', 'Application Support')
      : path.join(input.homeDir, '.config')

  const roots = [
    path.join(input.homeDir, 'camstack-agent-data'),
    path.join(input.homeDir, 'camstack-data'),
    ...KNOWN_ELECTRON_APP_IDS.map((id) => path.join(appSupport, ADDON_SCOPE, id, 'data')),
    path.join(appSupport, ADDON_SCOPE, 'electron-agent', 'agent-data'),
  ]

  const seen = new Set<string>()
  return roots.filter((r) => {
    if (seen.has(r)) return false
    seen.add(r)
    return true
  })
}

/** Filesystem operations the inventory needs, injected so it stays pure. */
export interface AddonRootFs {
  exists(dir: string): boolean
  /** Package directory names directly under an `addons/@camstack` dir. */
  listPackages(scopeDir: string): readonly string[]
  /** `version` from `<pkgDir>/package.json`, or null when missing/unparseable. */
  readVersion(packageDir: string): string | null
  /** Canonical path, so a symlink to the active root is not a rival. */
  realPath(dir: string): string
}

/** One addon root found on this machine that is not the one we are running. */
export interface RivalAddonRoot {
  /** The `<root>/addons/@camstack` directory. */
  readonly scopeDir: string
  readonly packageCount: number
  /** A few `name@version` samples — enough to recognise how stale it is. */
  readonly sample: readonly string[]
}

export interface AddonRootInventory {
  readonly activeScopeDir: string
  readonly rivals: readonly RivalAddonRoot[]
  readonly candidatesScanned: readonly string[]
}

/** Up to this many `name@version` pairs are sampled per rival root. */
const SAMPLE_SIZE = 4

export function inventoryAddonRoots(
  input: RivalRootInput,
  fs: AddonRootFs,
  candidates: readonly string[] = candidateDataRoots(input),
): AddonRootInventory {
  const activeScopeDir = path.join(input.activeAddonsDir, ADDON_SCOPE)
  const activeReal = fs.exists(activeScopeDir) ? fs.realPath(activeScopeDir) : activeScopeDir

  const rivals: RivalAddonRoot[] = []
  const seenReal = new Set<string>([activeReal])

  for (const root of candidates) {
    const scopeDir = path.join(root, ADDONS_SUBDIR, ADDON_SCOPE)
    if (!fs.exists(scopeDir)) continue
    // A symlink or bind pointing back at the live tree is the SAME root, not a
    // rival — reporting it would train operators to ignore this warning.
    const real = fs.realPath(scopeDir)
    if (seenReal.has(real)) continue
    seenReal.add(real)

    const packages = fs.listPackages(scopeDir)
    const sample = packages.slice(0, SAMPLE_SIZE).map((name) => {
      const version = fs.readVersion(path.join(scopeDir, name))
      return `${name}@${version ?? '<unreadable>'}`
    })
    rivals.push({ scopeDir, packageCount: packages.length, sample })
  }

  return { activeScopeDir, rivals, candidatesScanned: candidates }
}

/**
 * The loud report. Empty string when this machine has ONE addon root — a clean
 * node says nothing, so the one that isn't stands out instead of scrolling past.
 */
export function formatAddonRootReport(inventory: AddonRootInventory): string {
  if (inventory.rivals.length === 0) return ''
  const lines: string[] = [
    'A SECOND addon install location exists on this machine.',
    `This node loads addons from: ${inventory.activeScopeDir}`,
    'Every version below is true of a tree nothing is running. Reading one of',
    'them answers a question about the wrong node.',
    '',
  ]
  for (const rival of inventory.rivals) {
    lines.push(`  ${rival.scopeDir} — ${rival.packageCount} package(s)`)
    for (const entry of rival.sample) lines.push(`    ${entry}`)
  }
  lines.push('', '  Remove it, or confirm it is inert — it will be reported on every boot.')
  return lines.join('\n')
}
