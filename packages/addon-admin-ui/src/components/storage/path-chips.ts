/**
 * Turns a node's REAL root-directory listing (from `filesystem-browse.browse`
 * on `/`) into the path quick-suggestion chips shown by `PathBrowser`.
 *
 * The chips used to be the node's allowed roots, which on a container node are
 * OS defaults that either do not exist or are empty — while the node's own
 * storage locations lived at `/recordings` and `/data`, neither of them
 * suggested nor reachable. Suggesting what is actually mounted is the point, so
 * this filters only what can never be a storage target and otherwise shows
 * everything the node reported.
 */

export interface RootDirEntry {
  readonly name: string
  readonly path: string
}

/**
 * OS/runtime plumbing at `/`. Exact names only — a prefix rule would swallow
 * real mounts (`lib` must not hide a `library-media` volume).
 */
const HIDDEN_ROOT_DIRS: ReadonlySet<string> = new Set([
  // Linux
  'proc',
  'sys',
  'dev',
  'run',
  'boot',
  'lost+found',
  'snap',
  'bin',
  'sbin',
  'lib',
  'lib32',
  'lib64',
  'libx32',
  'usr',
  'etc',
  'var',
  'opt',
  'tmp',
  'srv',
  'root',
  // macOS
  'System',
  'Library',
  'Applications',
  'cores',
  'private',
])

/**
 * Names that lead the row when present — the ones an operator adding storage
 * is most likely to want. `recordings` matches by prefix so `recordings-high`
 * and `recordings-low` sit with it.
 */
const PRIORITY_NAMES: readonly string[] = ['recordings', 'data', 'mnt', 'media', 'Volumes']

function priorityRank(name: string): number {
  const i = PRIORITY_NAMES.findIndex((p) => (p === 'recordings' ? name.startsWith(p) : name === p))
  return i === -1 ? PRIORITY_NAMES.length : i
}

/** The chip list for a root listing: curated names first, then alphabetical. */
export function derivePathChips(rootEntries: readonly RootDirEntry[]): readonly string[] {
  return rootEntries
    .filter((e) => !e.name.startsWith('.') && !HIDDEN_ROOT_DIRS.has(e.name))
    .toSorted((a, b) => {
      const byRank = priorityRank(a.name) - priorityRank(b.name)
      return byRank !== 0 ? byRank : a.name.localeCompare(b.name)
    })
    .map((e) => e.path)
}
