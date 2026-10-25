/**
 * Closure dedupe — stop copying into every addon the libraries the server
 * closure already provides.
 *
 * `installRuntimeDependencies` materialises each addon's declared
 * `camstack.runtimeDependencies` (and their whole transitive tree) under
 * `<addonsDir>/<pkg>/node_modules`. Measured on the live hub (2026-09-04):
 * 196 MB across 23 addons, largely re-copies of libraries sitting one
 * directory away in `/data/server-root/current/node_modules` — `mediabunny`
 * (11 MB) twice, `werift` (~5 MB) three times, plus their shared subtrees
 * (`@noble`, `@peculiar`, `werift-*`).
 *
 * The fix: after an addon tree's npm install completes, every top-level
 * `node_modules` entry the closure ALSO provides at a compatible version is
 * replaced by a SYMLINK into the closure's `node_modules`. Symlinks preserve
 * standard Node resolution for BOTH module systems at ANY depth (verified on
 * the hub: `require()` and `import()` through a symlink on `/data/addons`
 * both resolve), and a dependency the closure later drops fails LOUDLY
 * (dangling link → `Cannot find module`) instead of silently degrading.
 *
 * Version compatibility is the sharp edge, measured live: the closure ships
 * `zod@4.5.4` while `@apocaliss92/nodelink-js` (provider-reolink) requires
 * `zod@^3` and carries `3.25.76`. A link there would silently downgrade a
 * dependent to an incompatible major — worse than the disk it saves. So a
 * link happens ONLY when the closure version satisfies EVERY requirement
 * range recorded for that package in the addon's own tree, under a
 * deliberately conservative range parser (exact / caret / tilde; anything
 * else refuses). Identical versions always link.
 *
 * Everything here is dependency-free on purpose (no `semver` package in the
 * kernel): the parser handles only the forms it can prove, and refusal keeps
 * the addon's own copy — never a wrong resolution.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { IScopedLogger } from '@camstack/types'
import { asJsonObject, asString, errMsg, parseJsonUnknown } from '@camstack/types'

// ---------------------------------------------------------------------------
// Conservative semver
// ---------------------------------------------------------------------------

interface ParsedVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: string | null
}

function parseVersion(value: string): ParsedVersion | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim())
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  }
}

/** -1 / 0 / 1 over the numeric triple only (callers gate prereleases first). */
function compareTriple(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  return 0
}

/**
 * Does `version` satisfy `range`, for the range forms this module is willing
 * to vouch for?
 *
 * Supported: exact (`1.2.3`, `=1.2.3`), caret (`^1.2.3`, incl. the 0.x rules)
 * and tilde (`~1.2.3`). EVERYTHING else — `*`, `>=`, unions, hyphen ranges,
 * dist-tags, bases with prereleases — returns false: an unprovable range must
 * keep the addon's own copy, never borrow the closure's.
 *
 * A prerelease `version` satisfies only an exact string match — semver range
 * semantics around prereleases are precisely the kind of subtlety a
 * hand-rolled parser must refuse rather than approximate.
 */
export function closureSatisfiesRange(range: string, version: string): boolean {
  const trimmedRange = range.trim()
  const v = parseVersion(version)
  if (v === null) return false
  if (v.prerelease !== null) {
    return trimmedRange === version.trim() || trimmedRange === `=${version.trim()}`
  }

  const exact = trimmedRange.startsWith('=') ? trimmedRange.slice(1) : trimmedRange
  const exactBase = parseVersion(exact)
  if (exactBase !== null) {
    return exactBase.prerelease === null && compareTriple(v, exactBase) === 0
  }

  const operator = trimmedRange[0]
  if (operator !== '^' && operator !== '~') return false
  const base = parseVersion(trimmedRange.slice(1))
  if (base === null || base.prerelease !== null) return false

  if (operator === '~') {
    return v.major === base.major && v.minor === base.minor && compareTriple(v, base) >= 0
  }
  // Caret: same major; for 0.x same minor; for 0.0.x exact patch.
  if (base.major > 0) {
    return v.major === base.major && compareTriple(v, base) >= 0
  }
  if (base.minor > 0) {
    return v.major === 0 && v.minor === base.minor && compareTriple(v, base) >= 0
  }
  return compareTriple(v, base) === 0
}

/**
 * Belt over the range check: the closure copy must live in the same major
 * line as the copy npm actually materialised (same minor while major is 0).
 * The range check should already guarantee this; if the two ever disagree
 * the safe answer is "do not link".
 */
export function sameCompatLine(a: string, b: string): boolean {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (pa === null || pb === null) return false
  if (pa.major !== pb.major) return false
  if (pa.major === 0) return pa.minor === pb.minor
  return true
}

// ---------------------------------------------------------------------------
// Plan (pure)
// ---------------------------------------------------------------------------

/** A real (non-symlink) top-level entry of an addon's node_modules. */
export interface DedupeCandidate {
  readonly name: string
  readonly version: string
}

export type ClosureKeepReason =
  | 'camstack-package'
  | 'never-link'
  | 'not-in-closure'
  | 'version-incompatible'

export interface ClosureLink {
  readonly name: string
  readonly closureVersion: string
}

export interface ClosureKeep {
  readonly name: string
  readonly reason: ClosureKeepReason
}

export interface ClosureDedupePlan {
  readonly links: readonly ClosureLink[]
  readonly keeps: readonly ClosureKeep[]
}

export interface ClosureDedupeInput {
  readonly candidates: readonly DedupeCandidate[]
  /** name → version installed in the server closure's node_modules. */
  readonly closureVersions: ReadonlyMap<string, string>
  /**
   * name → every requirement range the addon tree records for it (the addon's
   * own manifest + every dependent that resolves to the top-level copy).
   */
  readonly requirements: ReadonlyMap<string, readonly string[]>
  /** Names that must never be linked (e.g. `camstack.nativeDependencies`). */
  readonly neverLink: ReadonlySet<string>
}

/**
 * Decide, per top-level entry, whether the closure's copy can serve in place
 * of the addon's own. Identical versions always link; otherwise every
 * recorded requirement range must accept the closure version, and the two
 * copies must share a compat line. Anything unprovable keeps the local copy.
 */
export function planClosureDedupe(input: ClosureDedupeInput): ClosureDedupePlan {
  const links: ClosureLink[] = []
  const keeps: ClosureKeep[] = []
  for (const candidate of input.candidates) {
    if (candidate.name.startsWith('@camstack/')) {
      keeps.push({ name: candidate.name, reason: 'camstack-package' })
      continue
    }
    if (input.neverLink.has(candidate.name)) {
      keeps.push({ name: candidate.name, reason: 'never-link' })
      continue
    }
    const closureVersion = input.closureVersions.get(candidate.name)
    if (closureVersion === undefined) {
      keeps.push({ name: candidate.name, reason: 'not-in-closure' })
      continue
    }
    if (closureVersion === candidate.version) {
      links.push({ name: candidate.name, closureVersion })
      continue
    }
    const ranges = input.requirements.get(candidate.name) ?? []
    const compatible =
      ranges.length > 0 &&
      ranges.every((range) => closureSatisfiesRange(range, closureVersion)) &&
      sameCompatLine(closureVersion, candidate.version)
    if (compatible) {
      links.push({ name: candidate.name, closureVersion })
    } else {
      keeps.push({ name: candidate.name, reason: 'version-incompatible' })
    }
  }
  return { links, keeps }
}

// ---------------------------------------------------------------------------
// Tree state (fs reads)
// ---------------------------------------------------------------------------

interface TreeManifest {
  readonly version: string | null
  readonly ranges: ReadonlyMap<string, string>
}

function readTreeManifest(pkgJsonPath: string): TreeManifest | null {
  let raw: Record<string, unknown> | null
  try {
    raw = asJsonObject(parseJsonUnknown(fs.readFileSync(pkgJsonPath, 'utf-8')))
  } catch {
    return null
  }
  if (raw === null) return null
  const ranges = new Map<string, string>()
  for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    const deps = asJsonObject(raw[key])
    if (deps === null) continue
    for (const [name, range] of Object.entries(deps)) {
      if (typeof range === 'string' && !ranges.has(name)) ranges.set(name, range)
    }
  }
  const version = asString(raw['version'])
  return { version: version.length > 0 ? version : null, ranges }
}

/** Top-level entries of a node_modules dir (scoped names flattened). */
function listTopLevelEntries(nodeModulesDir: string): readonly string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true })
  } catch {
    return []
  }
  const names: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      let inner: fs.Dirent[]
      try {
        inner = fs.readdirSync(path.join(nodeModulesDir, entry.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const sub of inner) {
        if (!sub.name.startsWith('.')) names.push(`${entry.name}/${sub.name}`)
      }
    } else {
      names.push(entry.name)
    }
  }
  return names
}

export interface AddonTreeState {
  /** Real directories eligible for linking (symlinks are excluded). */
  readonly candidates: readonly DedupeCandidate[]
  /** name → requirement ranges collected across the tree. */
  readonly requirements: ReadonlyMap<string, readonly string[]>
  /** Top-level entries that are already symlinks (with their targets). */
  readonly existingLinks: readonly { readonly name: string; readonly target: string }[]
}

/**
 * Read an addon tree's dedupe-relevant state: which top-level packages exist
 * (and their versions), and which requirement ranges apply to each. A
 * dependent's range for `X` is recorded only when that dependent resolves to
 * the TOP-LEVEL `X` — a nested override copy (`dep/node_modules/X`) means the
 * flat copy is not what that dependent loads, so its range must not block the
 * flat copy's dedupe.
 */
export function collectAddonTreeState(addonDir: string): AddonTreeState {
  const nodeModulesDir = path.join(addonDir, 'node_modules')
  const requirements = new Map<string, string[]>()
  const addRange = (name: string, range: string): void => {
    const existing = requirements.get(name)
    if (existing === undefined) requirements.set(name, [range])
    else existing.push(range)
  }

  const rootManifest = readTreeManifest(path.join(addonDir, 'package.json'))
  if (rootManifest !== null) {
    for (const [name, range] of rootManifest.ranges) addRange(name, range)
  }

  const candidates: DedupeCandidate[] = []
  const existingLinks: { name: string; target: string }[] = []
  for (const name of listTopLevelEntries(nodeModulesDir)) {
    const entryDir = path.join(nodeModulesDir, name)
    let isLink = false
    try {
      isLink = fs.lstatSync(entryDir).isSymbolicLink()
    } catch {
      continue
    }
    if (isLink) {
      let target = ''
      try {
        target = fs.readlinkSync(entryDir)
      } catch {
        /* keep empty target — caller treats it as unknown */
      }
      existingLinks.push({ name, target })
    }
    const manifest = readTreeManifest(path.join(entryDir, 'package.json'))
    if (manifest === null) continue
    if (!isLink && manifest.version !== null) {
      candidates.push({ name, version: manifest.version })
    }
    for (const [depName, range] of manifest.ranges) {
      // A nested override means this dependent does NOT use the flat copy.
      if (fs.existsSync(path.join(entryDir, 'node_modules', depName))) continue
      addRange(depName, range)
    }
  }
  return { candidates, requirements, existingLinks }
}

/** Read `name → version` from a closure node_modules for the given names. */
export function readClosureVersions(
  closureNodeModulesDir: string,
  names: Iterable<string>,
): Map<string, string> {
  const versions = new Map<string, string>()
  for (const name of names) {
    const manifest = readTreeManifest(path.join(closureNodeModulesDir, name, 'package.json'))
    if (manifest !== null && manifest.version !== null) versions.set(name, manifest.version)
  }
  return versions
}

/**
 * Where the running node's server closure keeps its node_modules, or null
 * when there is none to dedupe against (dev workspace, tests without a
 * closure). `CAMSTACK_FRAMEWORK_DIR` is set by the starter/launcher on every
 * deployed node — the same directory the framework resolver hook and
 * NODE_PATH extension already point at.
 */
export function resolveClosureNodeModulesDir(explicitDir: string | undefined): string | null {
  const frameworkDir = explicitDir ?? process.env['CAMSTACK_FRAMEWORK_DIR']
  if (frameworkDir === undefined || frameworkDir.length === 0) return null
  const nodeModulesDir = explicitDir ?? path.join(frameworkDir, 'node_modules')
  return fs.existsSync(nodeModulesDir) ? nodeModulesDir : null
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

function symlinkType(): 'junction' | 'dir' {
  return process.platform === 'win32' ? 'junction' : 'dir'
}

/**
 * Replace each planned entry with a symlink into the closure. Probes symlink
 * support once (Windows without developer mode cannot create them — in that
 * case every copy is kept, which is exactly today's behaviour). Each link
 * re-verifies the closure version right before the swap so a closure updated
 * mid-flight can only cause a KEEP, never a wrong link.
 *
 * Returns the names actually linked.
 */
export function executeClosureDedupe(
  addonDir: string,
  closureNodeModulesDir: string,
  plan: ClosureDedupePlan,
  logger: IScopedLogger,
): readonly string[] {
  if (plan.links.length === 0) return []
  const nodeModulesDir = path.join(addonDir, 'node_modules')

  const probePath = path.join(nodeModulesDir, '.closure-link-probe')
  try {
    // A restored addon has NO node_modules at all (D338) — a link may be the
    // only thing it needs, so the dir is created rather than required.
    fs.mkdirSync(nodeModulesDir, { recursive: true })
    fs.rmSync(probePath, { force: true })
    fs.symlinkSync(closureNodeModulesDir, probePath, symlinkType())
    fs.rmSync(probePath, { force: true })
  } catch (err) {
    logger.warn('closure dedupe skipped — symlinks unavailable on this volume', {
      meta: { addonDir, error: errMsg(err) },
    })
    return []
  }

  const linked: string[] = []
  for (const link of plan.links) {
    const target = path.join(closureNodeModulesDir, link.name)
    const manifest = readTreeManifest(path.join(target, 'package.json'))
    if (manifest === null || manifest.version !== link.closureVersion) {
      logger.warn('closure dedupe — closure changed under the plan; keeping own copy', {
        meta: { name: link.name, planned: link.closureVersion, found: manifest?.version ?? null },
      })
      continue
    }
    const entryDir = path.join(nodeModulesDir, link.name)
    try {
      fs.rmSync(entryDir, { recursive: true, force: true })
      // Scoped names live one level down — the scope dir must exist.
      fs.mkdirSync(path.dirname(entryDir), { recursive: true })
      fs.symlinkSync(target, entryDir, symlinkType())
      linked.push(link.name)
    } catch (err) {
      logger.warn('closure dedupe — link failed; entry removed copy may need reinstall', {
        meta: { name: link.name, error: errMsg(err) },
      })
    }
  }
  return linked
}

/**
 * Is `linkTarget` (as read from `readlink`) a path inside the closure's
 * node_modules? Only such links belong to this mechanism — workspace/npm
 * `file:` links must never be touched by dedupe maintenance.
 */
export function isClosureLinkTarget(linkTarget: string, closureNodeModulesDir: string): boolean {
  if (linkTarget.length === 0) return false
  const normalized = path.resolve(linkTarget)
  const root = path.resolve(closureNodeModulesDir)
  return normalized === root || normalized.startsWith(`${root}${path.sep}`)
}
