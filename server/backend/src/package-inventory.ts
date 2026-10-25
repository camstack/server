/**
 * Boot-time inventory of host-provided packages — enforcement step 2 of
 * [D45](../../../docs/decisions/adr-0045.md).
 *
 * D45 requires exactly ONE copy of every host-provided package per node, inside
 * the active server closure. The record exists because that was not true: one
 * agent held four copies of `@camstack/system` — 1.2.28 under the image seed,
 * 1.2.28 under a second seed tree, 1.2.0 in the legacy `/data/framework`, and
 * 1.2.30 in the closure — and each could be truthfully quoted as "the version".
 * Three consecutive diagnoses of which one actually ran were each disproved by
 * the next measurement.
 *
 * Step 1 (the launcher naming the copy it RESOLVED) answers "which one runs".
 * This answers the other half — "what else is lying around that could have
 * run" — which is the question a resolved path alone cannot.
 *
 * WHERE a copy sits decides whether it is noise or a violation. Two of the four
 * copies above are EXPECTED: the `/opt` seed trees are baked into the image and
 * deliberately shadowed by the `/data/server-root/current` deposit on every
 * `applyServerUpdate`. Counting them as a violation printed the banner at every
 * boot on every node, which taught the operator to scroll past the one boot
 * where it mattered — the exact failure D45 exists to prevent. So the detector
 * classifies locations and screams only for a copy nobody deposits on purpose,
 * or for two copies that could BOTH be the one that runs. The expected
 * shadowing gets one compact line instead.
 *
 * Everything here is pure: the caller injects the three filesystem operations,
 * so the whole inventory is testable against a described layout rather than a
 * real disk.
 */
import * as path from 'node:path'

/**
 * Packages the closure provides to everything on the node. Addons never bundle
 * these ([D15](../../../docs/decisions/adr-0015.md)); a second copy on disk is
 * a resolution race waiting for a boot order to change.
 */
export const HOST_PROVIDED_PACKAGES: readonly string[] = [
  '@camstack/system',
  '@camstack/types',
  '@camstack/sdk',
]

/** The filesystem operations the inventory needs, injected so it stays pure. */
export interface InventoryFs {
  /** Does this package directory exist? */
  exists(packageDir: string): boolean
  /** The `version` from its package.json, or null when missing/unparseable. */
  readVersion(packageDir: string): string | null
  /** Canonical path, so a symlinked root is not counted as a second copy. */
  realPath(packageDir: string): string
}

/**
 * What a copy in this location MEANS.
 *
 * - `active` — the running server closure (`/data/server-root/current/…`). The
 *   deposit `applyServerUpdate` writes; the copy that actually resolves.
 * - `seed` — an image-baked tree under `/opt`. Present by construction on every
 *   node, shadowed by the deposit on every release. Expected, not a violation.
 * - `unexpected` — anywhere else: the legacy `/data/framework`, a bootstrap
 *   install under `/data/addons`, an extra `NODE_PATH` entry. Nobody deposits
 *   these on purpose, and each one is a resolution race D45 rules out.
 */
export type RootExpectation = 'active' | 'seed' | 'unexpected'

/** A directory to look under, and what a copy found there means. */
export interface InventoryRoot {
  readonly path: string
  readonly expectation: RootExpectation
}

/** One copy of one package, as found on disk. */
export interface PackageCopy {
  readonly pkg: string
  /** Where it is. A version without a path is not evidence — that is the point. */
  readonly path: string
  readonly version: string | null
  readonly location: RootExpectation
}

/** Every copy of ONE package, sorted into what each copy means. */
export interface PackageInventory {
  readonly pkg: string
  readonly copies: readonly PackageCopy[]
  /**
   * The copies that could be the one that runs. The deposit when there is one;
   * otherwise the seeds, because a package the deposit does not carry resolves
   * from wherever it does exist. More than one member is a race.
   */
  readonly activeCandidates: readonly PackageCopy[]
  /** Seed copies the active candidate shadows. Expected — worth a line, not a banner. */
  readonly shadowedSeeds: readonly PackageCopy[]
  /** Copies in a location nobody deposits on purpose. Always a violation. */
  readonly unexpected: readonly PackageCopy[]
  readonly violation: boolean
}

export interface InventoryResult {
  readonly copies: readonly PackageCopy[]
  readonly packages: readonly PackageInventory[]
  /**
   * Package names that VIOLATE D45 — an unexpected location, or two copies that
   * could both run. Not merely "found more than once": the fleet is built to
   * hold an image seed alongside the deposit, and calling that a violation is
   * how the banner became noise.
   */
  readonly violations: readonly string[]
  readonly rootsScanned: readonly string[]
}

/** Inputs describing where a copy could possibly live on this node. */
export interface SearchRootsInput {
  /** `process.env.NODE_PATH` AFTER the launcher has finished extending it. */
  readonly nodePath: string | undefined
  readonly pathSeparator: string
  /** The node's data dir (`CAMSTACK_DATA`). */
  readonly dataDir: string
  /**
   * `@camstack/server/node_modules` — the NESTED tree that resolves that
   * package's own dependencies. NOT where the framework packages live.
   */
  readonly serverNodeModules: string
  /**
   * The closure `node_modules` the launcher puts on NODE_PATH — where
   * `@camstack/system`, `types` and `sdk` actually resolve from. Active, like
   * {@link SearchRootsInput.serverNodeModules}: leaving it out made the guard
   * call the copies that RUN "unexpected". Optional so a caller that has no
   * framework dir (a workspace run) behaves exactly as before.
   */
  readonly frameworkRoots?: readonly string[]
  /** Image seed trees (`/opt/<name>/node_modules`). */
  readonly seedRoots: readonly string[]
}

/**
 * Every directory under which a host-provided package could sit as
 * `<root>/<pkgName>`.
 *
 * The list is explicit rather than a filesystem walk: these are the places a
 * copy has actually turned up, each named in D45, and a bounded list keeps this
 * to a handful of stat calls at boot. `/data/addons` is a root in its own right
 * because the bootstrap-install layout puts the package DIRECTLY there
 * (`/data/addons/@camstack/system`), not under a `node_modules`.
 *
 * A `NODE_PATH` entry is classified by WHICH directory it names, not by being
 * on `NODE_PATH`: the launcher puts the deposit and the seeds there itself, so
 * "it is on NODE_PATH" would mark the whole fleet unexpected.
 */
export function hostProvidedSearchRoots(input: SearchRootsInput): readonly InventoryRoot[] {
  const fromNodePath = (input.nodePath ?? '')
    .split(input.pathSeparator)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  const seedPaths = new Set(input.seedRoots)
  // BOTH deposit directories are active, and calling only one of them so is how
  // this guard spent every boot accusing the healthy layout.
  //
  // `serverNodeModules` is `@camstack/server/node_modules` — the NESTED tree,
  // which resolves that package's own dependencies. The framework packages
  // (`system`, `types`, `sdk`) do NOT live there: they resolve from the closure
  // directory one level up, which the launcher puts on NODE_PATH and logs as
  // "Framework dir on NODE_PATH". With only the nested tree marked active, the
  // closure arrived through NODE_PATH and was classified `unexpected`, so on
  // the live hub of 2026-08-25 the guard called the copies that actually run
  // "UNEXPECTED — remove it" and, left with the baked seeds as the only
  // candidates, declared them "CONFLICTS — could run" against each other.
  //
  // The runtime's own single-copy sweep disagreed in the same boot
  // (`single-copy cleanup — 0 copy(ies) to remove`). Two checkers, one disk,
  // opposite verdicts — and the one that shouts is the one that was wrong. A
  // guard that fires on the healthy state is ignored when it fires on the
  // broken one, which is the failure D45 exists to catch.
  const activePaths = new Set([input.serverNodeModules, ...(input.frameworkRoots ?? [])])
  const expectationFor = (dir: string): RootExpectation => {
    if (activePaths.has(dir)) return 'active'
    if (seedPaths.has(dir)) return 'seed'
    return 'unexpected'
  }

  const roots: readonly InventoryRoot[] = [
    { path: input.serverNodeModules, expectation: 'active' },
    ...(input.frameworkRoots ?? []).map((p) => ({ path: p, expectation: expectationFor(p) })),
    ...fromNodePath.map((p) => ({ path: p, expectation: expectationFor(p) })),
    { path: path.join(input.dataDir, 'framework', 'node_modules'), expectation: 'unexpected' },
    { path: path.join(input.dataDir, 'addons'), expectation: 'unexpected' },
    ...input.seedRoots.map((p) => ({ path: p, expectation: expectationFor(p) })),
  ]

  // First occurrence wins, and the deposit is listed first — so a directory
  // that is both the closure and a seed keeps the classification that decides
  // whether it runs.
  const seen = new Set<string>()
  return roots.filter((r) => {
    if (seen.has(r.path)) return false
    seen.add(r.path)
    return true
  })
}

/** The two filesystem calls {@link seedNodeModulesRoots} needs. */
export interface SeedScanFs {
  existsSync(p: string): boolean
  readdirSync(p: string): readonly string[]
}

/**
 * The image seed trees: `/opt/<name>/node_modules`.
 *
 * Enumerated rather than hardcoded because their names have changed with the
 * image layout (`camstack-hub`, `camstack-seed-framework`, …) and a hardcoded
 * list would quietly stop finding the copy it was written for. Returns empty
 * when `/opt` does not exist, which is every dev machine.
 */
export function seedNodeModulesRoots(fs: SeedScanFs, optDir = '/opt'): string[] {
  if (!fs.existsSync(optDir)) return []
  try {
    return fs
      .readdirSync(optDir)
      .map((name) => path.join(optDir, name, 'node_modules'))
      .filter((dir) => fs.existsSync(dir))
  } catch {
    return []
  }
}

/**
 * Find every copy of every host-provided package under `roots`.
 *
 * A copy whose package.json will not parse is still RECORDED, with a null
 * version. Dropping it would under-report the very thing this exists to
 * count — and an unreadable copy is exactly the kind that has been sitting
 * somewhere since an interrupted install.
 */
export function inventoryHostProvided(
  roots: readonly InventoryRoot[],
  fs: InventoryFs,
  packages: readonly string[] = HOST_PROVIDED_PACKAGES,
): InventoryResult {
  const copies: PackageCopy[] = []

  for (const pkg of packages) {
    // Keyed by canonical path: two roots that are the same directory (a
    // symlinked closure, a repeated NODE_PATH entry) are ONE copy, and calling
    // them two would cry wolf on a node that is actually compliant.
    const seenReal = new Set<string>()
    for (const root of roots) {
      const dir = path.join(root.path, pkg)
      if (!fs.exists(dir)) continue
      const real = fs.realPath(dir)
      if (seenReal.has(real)) continue
      seenReal.add(real)
      copies.push({ pkg, path: dir, version: fs.readVersion(dir), location: root.expectation })
    }
  }

  const byPkg = new Map<string, PackageCopy[]>()
  for (const c of copies) byPkg.set(c.pkg, [...(byPkg.get(c.pkg) ?? []), c])

  const inventories: readonly PackageInventory[] = [...byPkg.entries()]
    .map(([pkg, found]) => classifyPackage(pkg, found))
    .sort((a, b) => a.pkg.localeCompare(b.pkg))

  return {
    copies,
    packages: inventories,
    violations: inventories.filter((p) => p.violation).map((p) => p.pkg),
    rootsScanned: roots.map((r) => r.path),
  }
}

/**
 * Sort one package's copies into what each one means.
 *
 * A deposit copy shadows every seed — that is what `applyServerUpdate` does on
 * every release, so those seeds are not candidates for anything. With no
 * deposit copy the seeds ARE the candidates, and two of them is the resolution
 * race D45 was written about.
 */
function classifyPackage(pkg: string, found: readonly PackageCopy[]): PackageInventory {
  const active = found.filter((c) => c.location === 'active')
  const seeds = found.filter((c) => c.location === 'seed')
  const unexpected = found.filter((c) => c.location === 'unexpected')

  const activeCandidates = active.length > 0 ? active : seeds
  const shadowedSeeds = active.length > 0 ? seeds : []

  return {
    pkg,
    copies: found,
    activeCandidates,
    shadowedSeeds,
    unexpected,
    violation: unexpected.length > 0 || activeCandidates.length > 1,
  }
}

/**
 * The loud report. Empty string unless a copy is somewhere nobody deposits on
 * purpose, or two copies could both be the one that runs — an expected seed
 * under the deposit is the fleet's normal shape and reports nothing here, or
 * the banner would print on every boot of every node and be read on none.
 */
export function formatInventoryReport(result: InventoryResult): string {
  const violating = result.packages.filter((p) => p.violation)
  if (violating.length === 0) return ''

  const lines: string[] = [
    'D45 violation — a host-provided package sits somewhere it must not, or two',
    'copies could both be the one that runs. Which copy runs is then a',
    'module-resolution outcome, and every version this node reports is a claim',
    'about one of them rather than about the node.',
    '',
  ]
  for (const inv of violating) {
    lines.push(`  ${inv.pkg} — ${inv.copies.length} copies:`)
    for (const c of inv.copies) {
      lines.push(
        `    ${c.version ?? '<unreadable package.json>'}  [${describeLocation(c, inv)}]  ${c.path}`,
      )
    }
  }
  lines.push('', `  roots scanned: ${result.rootsScanned.join(', ')}`)
  return lines.join('\n')
}

/** Why this one copy is (or is not) part of the problem, in one word or two. */
function describeLocation(copy: PackageCopy, inv: PackageInventory): string {
  if (copy.location === 'unexpected') return 'UNEXPECTED — remove it'
  if (inv.activeCandidates.includes(copy)) {
    return inv.activeCandidates.length > 1 ? 'CONFLICTS — could run' : 'active'
  }
  return 'image seed, shadowed'
}

/**
 * The quiet half: the expected seed shadowing, one compact line per package.
 *
 * Deliberately not a banner and deliberately not phrased as a fault — the image
 * bakes these trees and the deposit shadows them on every release. A package
 * already named in {@link formatInventoryReport} is skipped: the banner lists
 * all of its copies, and a reassuring line beside it would read as verification.
 */
export function formatShadowingNotes(result: InventoryResult): readonly string[] {
  return result.packages
    .filter((p) => !p.violation && p.shadowedSeeds.length > 0)
    .map((p) => {
      const seedVersions = [...new Set(p.shadowedSeeds.map(describeVersion))].join(', ')
      const active = p.activeCandidates[0]
      const activeVersion = active === undefined ? 'unknown' : describeVersion(active)
      const activePath = active === undefined ? '' : ` (${active.path})`
      return `${p.pkg} — seed ${seedVersions} shadowed by active ${activeVersion}${activePath}`
    })
}

function describeVersion(copy: PackageCopy): string {
  return copy.version ?? '<unreadable package.json>'
}
