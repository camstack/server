/** Toolset names selected with `--toolsets a,b` (or CAMSTACK_MCP_TOOLSETS). */

export const ALL_TOOLSETS = [
  'knowledge',
  'ui',
  'caps',
  'addons',
  'ci',
  'release',
  'ops',
  'models',
] as const

export type Toolset = (typeof ALL_TOOLSETS)[number]

/** Offline `camstack-dev` default — no network / credentials. */
export const DEV_TOOLSETS: readonly Toolset[] = [
  'knowledge',
  'ui',
  'caps',
  'addons',
  'ci',
  'release',
]

/**
 * Credentialed `camstack-ops`: read-only by default; `--allow-mutations` adds
 * the two gated cluster mutations of `models` (D836).
 */
export const OPS_TOOLSETS: readonly Toolset[] = ['ops', 'models']

export function parseToolsets(argv: readonly string[]): readonly Toolset[] {
  const flagIdx = argv.findIndex((a) => a === '--toolsets' || a.startsWith('--toolsets='))
  let raw: string | undefined
  if (flagIdx >= 0) {
    const arg = argv[flagIdx]!
    raw = arg.includes('=') ? arg.split('=').slice(1).join('=') : argv[flagIdx + 1]
  }
  raw ??= process.env.CAMSTACK_MCP_TOOLSETS
  if (!raw || raw.trim() === '' || raw.trim() === 'dev') return DEV_TOOLSETS
  if (raw.trim() === 'ops') return OPS_TOOLSETS
  if (raw.trim() === 'all') return ALL_TOOLSETS
  const selected = raw
    .split(',')
    .map((s) => s.trim())
    .filter(isToolset)
  return selected.length > 0 ? selected : DEV_TOOLSETS
}

function isToolset(value: string): value is Toolset {
  return ALL_TOOLSETS.some((t) => t === value)
}

export function hasToolset(selected: readonly Toolset[], name: Toolset): boolean {
  return selected.includes(name)
}
