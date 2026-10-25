/**
 * The hubs an agent can be pointed at (D839): what the LAN announces over mDNS
 * (the same browse the CLI uses, D838) plus the hub address this agent is
 * already configured with, each probed on its https port, the unreachable
 * dropped. The agent UI shows them so an operator picks instead of typing.
 *
 * A browse takes a few seconds, so it never runs on the status poll: the
 * snapshot is cached, a refresh is explicit, and concurrent refreshes share
 * one scan.
 */
import type { DiscoverHubsDeps, HubCandidate } from '@camstack/develop/hub-discovery'
import { deriveHubUrlFromHubAddress } from './derive-hub-url.js'

/** Label of the configured hub in {@link FoundHub.sources}. */
export const CONFIGURED_HUB_SOURCE = 'configured hub address'
/** A scan newer than this answers a refresh without scanning again. */
const MIN_RESCAN_INTERVAL_MS = 5_000
const BROWSE_TIMEOUT_MS = 3_000

/** One reachable hub as the agent UI lists it. */
export interface FoundHub {
  /** `https://host:port` of the hub's API. */
  readonly url: string
  /** What fills the agent's hub-address field. */
  readonly host: string
  readonly nodeId: string | null
  readonly version: string | null
  /** Where it was learned: "LAN (mDNS)", "configured hub address". */
  readonly sources: readonly string[]
}

/** What `GET /api/agent/hubs-found` answers. */
export interface HubsFoundSnapshot {
  readonly hubs: readonly FoundHub[]
  /** Epoch ms of the last finished scan; `null` before the first one. */
  readonly scannedAt: number | null
  /** A scan is running right now. */
  readonly scanning: boolean
}

export type DiscoverHubsFn = (deps: DiscoverHubsDeps) => Promise<readonly HubCandidate[]>

export interface HubsFinderDeps {
  /** The agent's configured hub address (`host[:port]`), read per scan. */
  readonly getConfiguredHubAddress: () => string | null
  readonly discover?: DiscoverHubsFn
  readonly now?: () => number
  readonly log?: (message: string) => void
}

export interface HubsFinder {
  snapshot(): HubsFoundSnapshot
  /** Scan now (or reuse a scan younger than the minimum interval). Never throws. */
  refresh(): Promise<HubsFoundSnapshot>
}

function toFoundHub(candidate: HubCandidate): FoundHub {
  return {
    url: candidate.url,
    host: candidate.host,
    nodeId: candidate.nodeId,
    version: candidate.version,
    sources: candidate.sources,
  }
}

async function defaultDiscover(deps: DiscoverHubsDeps): Promise<readonly HubCandidate[]> {
  // Lazy: the socket library is only loaded when an operator asks.
  const { discoverHubs } = await import('@camstack/develop/hub-discovery')
  return discoverHubs(deps)
}

export function createHubsFinder(deps: HubsFinderDeps): HubsFinder {
  const discover = deps.discover ?? defaultDiscover
  const now = deps.now ?? Date.now
  let hubs: readonly FoundHub[] = []
  let scannedAt: number | null = null
  let inFlight: Promise<HubsFoundSnapshot> | null = null

  const snapshot = (): HubsFoundSnapshot => ({ hubs, scannedAt, scanning: inFlight !== null })

  const scan = async (): Promise<HubsFoundSnapshot> => {
    const configured = deps.getConfiguredHubAddress()
    const configuredUrl = configured === null ? undefined : deriveHubUrlFromHubAddress(configured)
    try {
      const found = await discover({
        mdnsTimeoutMs: BROWSE_TIMEOUT_MS,
        known:
          configuredUrl === undefined
            ? []
            : [{ url: configuredUrl, source: CONFIGURED_HUB_SOURCE }],
        onProblem: (message) => deps.log?.(`hub browse problem: ${message}`),
      })
      hubs = found.map(toFoundHub)
    } catch (err: unknown) {
      // A failed scan keeps the previous list: unknown is not "no hub".
      deps.log?.(`hub scan failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    scannedAt = now()
    return { hubs, scannedAt, scanning: false }
  }

  return {
    snapshot,
    refresh: () => {
      if (inFlight !== null) return inFlight
      if (scannedAt !== null && now() - scannedAt < MIN_RESCAN_INTERVAL_MS) {
        return Promise.resolve(snapshot())
      }
      const running = scan().finally(() => {
        inFlight = null
      })
      inFlight = running
      return running
    },
  }
}
