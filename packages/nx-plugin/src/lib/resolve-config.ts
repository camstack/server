import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Resolved deploy configuration after merging precedence layers:
 *   1. Executor options (project.json `options.server` / `options.token`)
 *   2. Environment ($CAMSTACK_SERVER / $CAMSTACK_TOKEN)
 *   3. rc file ($HOME/.camstackrc, simple `KEY=value` lines)
 *   4. Built-in defaults (server only; no token default)
 */
export interface ResolvedDeployConfig {
  readonly server: string
  readonly token: string
}

export interface ResolveInputs {
  readonly server?: string
  readonly token?: string
  /** Override `process.env` for tests. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Override the rc file path (default: $HOME/.camstackrc). */
  readonly rcPath?: string
}

const DEFAULT_SERVER = 'http://localhost:4443'

/**
 * Parse a `.camstackrc`-style file. Supports `KEY=value` lines,
 * blank lines, and `#`-prefixed comments. Quoting (single or double)
 * is stripped so users who write `CAMSTACK_TOKEN="foo"` aren't
 * surprised. Unknown keys are ignored — only the two we care about
 * are extracted.
 */
export function parseRc(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    // Strip surrounding matching quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/**
 * Merge precedence: explicit options > env vars > rc file > defaults.
 * Throws when no token is resolvable — server has a sensible default
 * for local dev, but uploading without a token is never useful.
 */
export function resolveDeployConfig(inputs: ResolveInputs): ResolvedDeployConfig {
  const env = inputs.env ?? process.env
  const rcPath = inputs.rcPath ?? path.join(os.homedir(), '.camstackrc')

  let rcServer: string | undefined
  let rcToken: string | undefined
  if (fs.existsSync(rcPath)) {
    const parsed = parseRc(fs.readFileSync(rcPath, 'utf-8'))
    rcServer = parsed['CAMSTACK_SERVER']
    rcToken = parsed['CAMSTACK_TOKEN']
  }

  const server = inputs.server ?? env['CAMSTACK_SERVER'] ?? rcServer ?? DEFAULT_SERVER

  const token = inputs.token ?? env['CAMSTACK_TOKEN'] ?? rcToken ?? ''

  if (!token) {
    throw new Error(
      `No auth token resolved. Provide one of:\n` +
        `  • executor option \`token\`\n` +
        `  • $CAMSTACK_TOKEN environment variable\n` +
        `  • CAMSTACK_TOKEN= in ${rcPath}`,
    )
  }

  return { server: server.replace(/\/+$/, ''), token }
}
