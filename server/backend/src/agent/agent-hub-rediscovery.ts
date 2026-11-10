/**
 * A paired agent with no hub address finds ITS hub again (#494).
 *
 * Pairing records the hub's address AND its announced identity (`hubId`,
 * random, generated once on the hub). If the address is ever missing, the
 * agent browses `_camstack._tcp` and adopts the one hub announcing that exact
 * id - never another hub on the same LAN, never a hub announcing none. The
 * address is persisted only after that hub answers a membership query the
 * pinned CA verifies (the id itself is public). The next boot then dials it.
 */
import type { BrowseOptions, MdnsHub } from '@camstack/develop/hub-discovery'
import { dialableHubHost, isAnnouncedHubId } from '@camstack/server/system'
import { readJsonFile, writeJsonFile0600 } from './agent-json-file.js'
import { isAgentPaired, readPairedHubIdentity } from './agent-pairing-store.js'
import { askHubMembership } from './hub-membership-client.js'

/** Where an operator sets the address. The agent page shows it read-only. */
export const HUB_ADDRESS_REPAIR_HINT =
  "Re-pair this agent from the hub's Nodes page; the hub address on this agent is read-only"

const NO_HUB_ID_WARNING =
  'Paired, but no hub address and no hub id on record: this agent cannot find its hub on its own. ' +
  HUB_ADDRESS_REPAIR_HINT

/** How long one boot-time browse listens. */
export const HUB_REDISCOVERY_BROWSE_MS = 4_000
/** While a paired agent waits for its hub, how often it looks again. */
export const HUB_REDISCOVERY_INTERVAL_MS = 60_000

export type HubRediscovery =
  /** Unpaired, or the address is already there. */
  | { readonly kind: 'not-needed' }
  /** Paired before the hub announced an id: there is nothing to match on. */
  | { readonly kind: 'no-hub-id' }
  /** No dialable hub announced the recorded id; `announced` hubs were seen. */
  | { readonly kind: 'not-found'; readonly announced: number }
  | { readonly kind: 'found'; readonly hubAddress: string; readonly hubUrl: string }

/** One announced URL the pinned CA must vouch for before it is saved. */
export interface HubRediscoveryCandidate {
  readonly hubUrl: string
}

/**
 * Shared by the boot browse and the watch so a `no-hub-id` warning is logged
 * once, and again only after a later browse saw a hub id and then lost it.
 * The two callers update `noHubIdWarned`; nothing else should.
 */
export interface HubRediscoveryNotice {
  noHubIdWarned: boolean
}

export function createHubRediscoveryNotice(): HubRediscoveryNotice {
  return { noHubIdWarned: false }
}

export interface HubRediscoveryDeps {
  readonly configPath: string
  readonly log: {
    info(message: string, extras?: { meta?: Record<string, unknown> }): void
    warn(message: string, extras?: { meta?: Record<string, unknown> }): void
    error?(message: string, extras?: { meta?: Record<string, unknown> }): void
  }
  readonly browse?: (options: BrowseOptions) => Promise<readonly MdnsHub[]>
  readonly timeoutMs?: number
  /**
   * `true` when `hubUrl` answered with a token the CA pinned at pairing
   * verifies. Defaults to `askHubMembership`.
   */
  readonly authenticate?: (candidate: HubRediscoveryCandidate) => Promise<boolean>
  readonly notice?: HubRediscoveryNotice
}

async function defaultBrowse(options: BrowseOptions): Promise<readonly MdnsHub[]> {
  // Lazy: the socket library is loaded only when an agent actually lost its hub.
  const { browseHubsMdns } = await import('@camstack/develop/hub-discovery')
  return browseHubsMdns(options)
}

function hasHubAddress(config: Record<string, unknown>): boolean {
  const value = config['hubAddress']
  return typeof value === 'string' && value.trim().length > 0
}

/** The dialable host of an announced hub URL, or `null`. */
function hostOf(url: string): string | null {
  try {
    return dialableHubHost(new URL(url).hostname)
  } catch {
    return null
  }
}

/** The pinned CA vouches for `hubUrl`, or the candidate is refused. A thrown client is a refusal. */
async function pinnedCaAccepts(configPath: string, hubUrl: string): Promise<boolean> {
  const identity = readPairedHubIdentity(configPath)
  const nodeId = readJsonFile(configPath)['nodeId']
  if (identity === null || typeof nodeId !== 'string' || nodeId.length === 0) return false
  const result = await askHubMembership({
    hubUrl,
    nodeId,
    certPem: identity.certPem,
    keyPem: identity.keyPem,
    caCertPem: identity.caCertPem,
  })
  return result.kind === 'answer'
}

function warnNoHubId(deps: HubRediscoveryDeps): void {
  if (deps.notice?.noHubIdWarned === true) return
  deps.log.warn(NO_HUB_ID_WARNING)
  if (deps.notice !== undefined) deps.notice.noHubIdWarned = true
}

async function authenticateCandidate(deps: HubRediscoveryDeps, hubUrl: string): Promise<boolean> {
  const authenticate =
    deps.authenticate ?? ((candidate) => pinnedCaAccepts(deps.configPath, candidate.hubUrl))
  try {
    return await authenticate({ hubUrl })
  } catch (err: unknown) {
    deps.log.warn('hub authentication failed', {
      meta: { hubUrl, error: err instanceof Error ? err.message : String(err) },
    })
    return false
  }
}

export async function rediscoverPairedHub(deps: HubRediscoveryDeps): Promise<HubRediscovery> {
  const config = readJsonFile(deps.configPath)
  if (!isAgentPaired(deps.configPath) || hasHubAddress(config)) return { kind: 'not-needed' }
  const hubId = config['hubId']
  if (!isAnnouncedHubId(hubId)) {
    warnNoHubId(deps)
    return { kind: 'no-hub-id' }
  }
  if (deps.notice !== undefined) deps.notice.noHubIdWarned = false
  const announced = await (deps.browse ?? defaultBrowse)({
    timeoutMs: deps.timeoutMs ?? HUB_REDISCOVERY_BROWSE_MS,
    onProblem: (message) => deps.log.warn(`hub browse problem: ${message}`),
  })
  for (const hub of announced) {
    if (hub.hubId !== hubId) continue
    const hubAddress = hostOf(hub.url)
    if (hubAddress === null) continue
    if (!(await authenticateCandidate(deps, hub.url))) {
      deps.log.warn(
        'an announced hub has this hub id but did not authenticate against the CA pinned at pairing',
        { meta: { hubId, hubUrl: hub.url } },
      )
      continue
    }
    // Re-read right before writing: only the address keys change.
    writeJsonFile0600(deps.configPath, {
      ...readJsonFile(deps.configPath),
      hubAddress,
      hubUrl: hub.url,
    })
    deps.log.info('Found the paired hub on the LAN by its hub id - address saved', {
      meta: { hubId, hubAddress, hubUrl: hub.url },
    })
    return { kind: 'found', hubAddress, hubUrl: hub.url }
  }
  deps.log.warn(`No hub on the LAN announces this agent's hub id ${hubId}`, {
    meta: { hubId, announced: announced.length },
  })
  return { kind: 'not-found', announced: announced.length }
}

export interface HubRediscoveryWatchDeps extends HubRediscoveryDeps {
  /** The address was found and saved: relaunch so the addons boot against it (D5). */
  readonly onFound: () => void
  readonly intervalMs?: number
}

/**
 * While a paired agent has no hub (boot mode `awaiting-hub`), look for its hub id again on a
 * fixed cadence - one browse at a time - until it is found once. Returns a stop function.
 */
export function startHubRediscoveryWatch(deps: HubRediscoveryWatchDeps): () => void {
  let running = false
  let done = false
  const tick = async (): Promise<void> => {
    if (running || done) return
    running = true
    try {
      const outcome = await rediscoverPairedHub(deps)
      // `not-needed`: an address arrived another way (the agent page); relaunch for it as well.
      if (outcome.kind === 'found' || outcome.kind === 'not-needed') {
        done = true
        clearInterval(timer)
        deps.onFound()
      }
    } catch (err: unknown) {
      deps.log.warn('hub rediscovery failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void tick(), deps.intervalMs ?? HUB_REDISCOVERY_INTERVAL_MS)
  timer.unref?.()
  return () => {
    done = true
    clearInterval(timer)
  }
}
