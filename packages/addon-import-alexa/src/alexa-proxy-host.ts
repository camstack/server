import { errMsg, type IScopedLogger } from '@camstack/types'

/**
 * Which host the operator's browser uses to reach the Amazon-login proxy.
 *
 * The proxy listens on its own port over plain HTTP and alexa-cookie2 rewrites
 * every Amazon URL to `http://<host>:<port>/`, so the host must be one the
 * browser reaches DIRECTLY — a LAN address of the hub. The hub's address is not
 * an environment fact (D729/D732/D734): it comes from the `local-network`
 * palette, role `appConnections` (the addresses a client app or browser opens).
 * That role lists the LAN IPv4 addresses and the public tunnel; only the first
 * LAN-host entry (in the role's own order) is useful here, and only its
 * hostname — the port is the proxy's.
 */

export type AlexaProxyHostFailure = 'palette-unavailable' | 'no-lan-address'

/** Typed refusal: names WHY no proxy host could be chosen. */
export class AlexaProxyHostError extends Error {
  readonly reason: AlexaProxyHostFailure

  constructor(reason: AlexaProxyHostFailure, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AlexaProxyHostError'
    this.reason = reason
  }
}

export interface ResolveProxyHostInput {
  /** The operator's `proxyHost` setting; non-blank wins outright. */
  readonly override: string
  /** `local-network.getAddresses().roles.appConnections.resolved`. */
  readonly readAppConnections: () => Promise<readonly string[]>
  readonly logger: IScopedLogger
}

const PRIVATE_IPV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/
const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/

/** A host a browser on the hub's network reaches directly: private IPv4, `.local`, or a bare name. */
export function isLanHost(host: string): boolean {
  if (host.length === 0) return false
  if (IPV4_LITERAL.test(host)) return PRIVATE_IPV4.test(host)
  if (host.includes(':')) return false // IPv6 literal
  return host.endsWith('.local') || !host.includes('.')
}

function lanHostOf(address: string): string | null {
  try {
    const host = new URL(address).hostname
    return isLanHost(host) && host !== 'localhost' ? host : null
  } catch {
    return null
  }
}

export async function resolveProxyHost(input: ResolveProxyHostInput): Promise<string> {
  const override = input.override.trim()
  if (override.length > 0) return override

  let addresses: readonly string[]
  try {
    addresses = await input.readAppConnections()
  } catch (err: unknown) {
    input.logger.warn('alexa proxy-login: hub addresses unavailable from local-network', {
      meta: { error: errMsg(err) },
    })
    throw new AlexaProxyHostError(
      'palette-unavailable',
      'alexa proxy-login: the hub address list is unavailable — set proxyHost in settings',
      { cause: err },
    )
  }

  for (const address of addresses) {
    const host = lanHostOf(address)
    if (host !== null) return host
  }
  input.logger.warn('alexa proxy-login: no LAN address among the hub appConnections', {
    meta: { addresses: [...addresses] },
  })
  throw new AlexaProxyHostError(
    'no-lan-address',
    'alexa proxy-login: the hub has no LAN address the browser can open directly — set proxyHost in settings',
  )
}
