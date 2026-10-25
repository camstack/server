/**
 * Find the hubs a CLI can log into (D838): what the LAN announces over mDNS,
 * UNION the hubs this machine already knows — cached sessions,
 * `$CAMSTACK_HUB_URL`, the repo's `scratchpad/.hub-url`. Each candidate
 * is probed on its https port and the unreachable ones are dropped; the rest
 * are deduped by host:port with every source that named them kept.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  defaultSessionDir,
  isSessionFile,
  resolveHubUrl,
  validateHubAddress,
} from '@camstack/develop'
import {
  type BrowseOptions,
  discoverHubs,
  type HubCandidate,
  type MdnsHub,
  type RawCandidate,
} from '@camstack/develop/hub-discovery'

export type { HubCandidate }

export interface FindHubsDeps {
  readonly sessionDir?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  /** The checkout whose `scratchpad/.hub-url` may name a hub. */
  readonly workspaceRoot?: string
  readonly browse?: (options: BrowseOptions) => Promise<readonly MdnsHub[]>
  readonly probe?: (host: string, port: number) => Promise<boolean>
  readonly mdnsTimeoutMs?: number
  readonly onProblem?: (message: string) => void
}

/** A hub address typed by the operator (any form `normalizeHubAddress` takes); an error message otherwise. */
export function validateManualHubUrl(value: string): string | undefined {
  return validateHubAddress(value)
}

/** The hubs this machine already knows, each tagged with where it learned it. */
export function knownHubCandidates(
  deps: Pick<FindHubsDeps, 'sessionDir' | 'env' | 'workspaceRoot'>,
): readonly RawCandidate[] {
  const dir = deps.sessionDir ?? defaultSessionDir()
  const env = deps.env ?? process.env
  const out: RawCandidate[] = []
  let files: string[] = []
  try {
    files = fs.readdirSync(dir)
  } catch {
    files = []
  }
  for (const file of files) {
    if (file.endsWith('.json')) {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
        if (isSessionFile(parsed)) {
          out.push({
            url: parsed.server,
            source: `saved session ${parsed.username}`,
          })
        }
      } catch {
        // A torn session file is not a hub.
      }
    }
  }
  const fromEnv = resolveHubUrl({ env, session: null })
  if (fromEnv) {
    const name =
      (env['CAMSTACK_HUB_URL'] ?? '').trim() === '' ? 'CAMSTACK_SERVER' : 'CAMSTACK_HUB_URL'
    out.push({ url: fromEnv.url, source: name })
  }
  if (deps.workspaceRoot !== undefined) {
    const scratch = resolveHubUrl({
      env: {},
      workspaceRoot: deps.workspaceRoot,
      session: null,
    })
    if (scratch) out.push({ url: scratch.url, source: 'scratchpad/.hub-url' })
  }
  return out
}

/** The hubs worth offering: announced or known, deduped, and answering on https. */
export async function findHubs(deps: FindHubsDeps = {}): Promise<readonly HubCandidate[]> {
  return discoverHubs({
    known: knownHubCandidates(deps),
    ...(deps.browse ? { browse: deps.browse } : {}),
    ...(deps.probe ? { probe: deps.probe } : {}),
    ...(deps.mdnsTimeoutMs !== undefined ? { mdnsTimeoutMs: deps.mdnsTimeoutMs } : {}),
    ...(deps.onProblem ? { onProblem: deps.onProblem } : {}),
  })
}

/** One line per hub: address, identity when known, and where it came from. */
export function describeHub(hub: HubCandidate): string {
  const identity = [hub.nodeId, hub.version === null ? null : `v${hub.version}`]
    .filter((p): p is string => p !== null)
    .join(' ')
  return `${hub.url}${identity === '' ? '' : `  ${identity}`}  (${hub.sources.join(', ')})`
}
