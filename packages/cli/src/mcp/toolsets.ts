/**
 * Toolsets of `camstack mcp`, selected with `--toolsets setup,ops,configure`.
 *
 *  - `setup`     hub-less: needs no credentials (versions, supported hosts).
 *  - `ops`       read-only questions to a hub, through the CLI's own session.
 *  - `configure` writes, every one two-step through the mutation gate.
 *  - `support`   benchmarks, accelerator and camera diagnosis, issue and PR drafts;
 *                the benchmark run and the drafts go through the mutation gate.
 *  - `develop`   addon-author tools, registered by `@camstack/mcp-develop`.
 */

export const TOOLSET_NAMES = ['setup', 'ops', 'configure', 'support', 'develop'] as const

export type Toolset = (typeof TOOLSET_NAMES)[number]

/** What a bare `camstack mcp` serves. `develop` is opt-in: it reads a checkout. */
export const DEFAULT_TOOLSETS: readonly Toolset[] = ['setup', 'ops', 'configure', 'support']

export type ToolsetParse =
  | { readonly ok: true; readonly toolsets: readonly Toolset[] }
  | { readonly ok: false; readonly error: string }

function isToolset(value: string): value is Toolset {
  return TOOLSET_NAMES.some((name) => name === value)
}

/**
 * `raw` is the value of `--toolsets`. Absent or blank selects the default; an
 * unknown name is an error (a typo must not silently serve fewer tools).
 */
export function parseToolsets(raw: string | undefined): ToolsetParse {
  if (raw === undefined || raw.trim() === '') return { ok: true, toolsets: DEFAULT_TOOLSETS }
  const names = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
  const selected: Toolset[] = []
  for (const name of names) {
    if (!isToolset(name)) {
      return {
        ok: false,
        error: `unknown toolset "${name}" (available: ${TOOLSET_NAMES.join(', ')})`,
      }
    }
    if (!selected.includes(name)) selected.push(name)
  }
  if (selected.length === 0) return { ok: true, toolsets: DEFAULT_TOOLSETS }
  return { ok: true, toolsets: selected }
}
