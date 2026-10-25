/**
 * The two network facts the auth surface reads from settings:
 *
 *  - `auth.trustedProxies` — CIDRs whose forwarding headers are believed, on
 *    top of loopback (`client-address.ts`);
 *  - `auth.trustedNetworks` — CIDRs a login may skip its second factor from
 *    (opt-in, empty = off). Only for a request made DIRECTLY from such a
 *    network: anything that came through a proxy — the Cloudflare tunnel, the
 *    public origin — never qualifies, whatever address it claims.
 *
 * Settings are read on every call (the hub's ConfigService answers from
 * memory), so a change applies to the next request. A read the store cannot
 * answer yet is treated as an EMPTY list: no extra proxy is trusted, and no
 * network skips a factor — both fail closed.
 */
import { createCidrMatcher, type CidrMatcher, readCidrSetting } from '@camstack/system'
import { type ClientAddress, resolveClientAddress } from './client-address.js'

export const TRUSTED_PROXIES_KEY = 'auth.trustedProxies'
export const TRUSTED_NETWORKS_KEY = 'auth.trustedNetworks'

export interface AuthNetworkPolicy {
  /** The request's real client address (forwarding headers only via a trusted proxy). */
  clientAddress(req: unknown): ClientAddress
  /**
   * May a login from `address` skip its second factor? Only when the operator
   * listed a trusted network, the client is inside it, and the request did
   * NOT come through any proxy.
   */
  isTrustedNetworkLogin(address: ClientAddress): boolean
}

export type SettingReader = (key: string) => unknown

interface RequestShape {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  readonly socket?: { readonly remoteAddress?: string | undefined } | null
}

function asRequest(req: unknown): RequestShape | null {
  if (req === null || typeof req !== 'object') return null
  const headers: unknown = Reflect.get(req, 'headers')
  if (headers === null || typeof headers !== 'object') return null
  const socket: unknown = Reflect.get(req, 'socket')
  const remoteAddress: unknown =
    socket !== null && typeof socket === 'object' ? Reflect.get(socket, 'remoteAddress') : undefined
  return {
    headers: Object.fromEntries(
      Object.entries(headers).filter(
        (e): e is [string, string | string[]] => typeof e[1] === 'string' || Array.isArray(e[1]),
      ),
    ),
    socket: { remoteAddress: typeof remoteAddress === 'string' ? remoteAddress : undefined },
  }
}

function safeList(read: SettingReader, key: string): readonly string[] {
  try {
    return readCidrSetting(read(key))
  } catch {
    return []
  }
}

/** One memo per list: rebuilding a BlockList per request is wasted work. */
function memoMatcher(): (entries: readonly string[]) => CidrMatcher {
  let lastKey: string | null = null
  let last: CidrMatcher = createCidrMatcher([])
  return (entries) => {
    const key = entries.join('\n')
    if (key !== lastKey) {
      lastKey = key
      last = createCidrMatcher(entries)
    }
    return last
  }
}

export function createAuthNetworkPolicy(read: SettingReader): AuthNetworkPolicy {
  const networks = memoMatcher()
  return {
    clientAddress(req) {
      const request = asRequest(req)
      if (request === null) return { ip: null, peer: null, viaProxy: false }
      return resolveClientAddress(request, { trustedProxies: safeList(read, TRUSTED_PROXIES_KEY) })
    },
    isTrustedNetworkLogin(address) {
      if (address.viaProxy || address.ip === null) return false
      return networks(safeList(read, TRUSTED_NETWORKS_KEY)).contains(address.ip)
    },
  }
}

/** No settings: loopback is the only trusted proxy, no network skips a factor. */
export const DEFAULT_AUTH_NETWORK_POLICY: AuthNetworkPolicy = createAuthNetworkPolicy(
  () => undefined,
)
