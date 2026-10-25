/**
 * Which hub a tool talks to. Never a literal address in code: the hub URL is
 * the operator's, found in this order (first hit wins).
 *
 *   1. an explicit value (a `--server` flag)
 *   2. `$CAMSTACK_HUB_URL`
 *   3. `$CAMSTACK_SERVER`           (the CLI's name for the same thing)
 *   4. `<workspace>/scratchpad/.hub-url`  (gitignored, one line)
 *   5. the cached `camstack login` session's server
 *
 * Sources 1-4 are operator-typed, so each goes through `normalizeHubAddress`
 * (`192.0.2.20` -> `https://192.0.2.20:4443`); a malformed value throws a
 * `HubAddressError` rather than being used as written.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { normalizeHubAddress } from './hub-address.js'

export interface HubUrlInputs {
  readonly explicit?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  /** The checkout whose `scratchpad/.hub-url` may name the hub. */
  readonly workspaceRoot?: string
  readonly session?: { readonly server: string } | null
}

export type HubUrlSource = 'flag' | 'env' | 'scratchpad' | 'session'

export interface ResolvedHubUrl {
  readonly url: string
  readonly source: HubUrlSource
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? normalizeHubAddress(trimmed) : undefined
}

/** The session's server as saved: already canonical, never re-parsed. */
function cleanSession(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\/+$/, '')
  return trimmed ? trimmed : undefined
}

function readScratchpadHubUrl(workspaceRoot: string | undefined): string | undefined {
  if (!workspaceRoot) return undefined
  const file = path.join(workspaceRoot, 'scratchpad', '.hub-url')
  try {
    return clean(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** The hub URL, or `undefined` when no source names one. */
export function resolveHubUrl(inputs: HubUrlInputs): ResolvedHubUrl | undefined {
  const env = inputs.env ?? process.env
  const explicit = clean(inputs.explicit)
  if (explicit) return { url: explicit, source: 'flag' }
  const fromEnv = clean(env['CAMSTACK_HUB_URL']) ?? clean(env['CAMSTACK_SERVER'])
  if (fromEnv) return { url: fromEnv, source: 'env' }
  const scratch = readScratchpadHubUrl(inputs.workspaceRoot)
  if (scratch) return { url: scratch, source: 'scratchpad' }
  const session = cleanSession(inputs.session?.server)
  if (session) return { url: session, source: 'session' }
  return undefined
}
