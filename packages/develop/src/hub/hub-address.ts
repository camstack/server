/**
 * The ONE parser for "which hub": every tool that takes a server (the CLI's
 * login/whoami/deploy/dev/watch, `scripts/hub/hub.mjs`, the operator MCP)
 * passes its input through {@link normalizeHubAddress}, so `192.0.2.20`,
 * `hub.local:4443` and `https://[fe80::1]:4443/` all name the same canonical
 * `https://<host>:<port>` and a typo fails the same way everywhere.
 *
 * The hub API is https only (self-signed on the LAN, trusted per hub): an
 * `http://` address is refused with a message instead of being rewritten, so
 * the operator learns the scheme rather than silently talking to another port.
 */

export const DEFAULT_HUB_PORT = 4443

export class HubAddressError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HubAddressError'
  }
}

const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i
const BRACKETED = /^\[([^\]]+)\](?::(\d+))?$/
const HOST_PORT = /^([^:]+)(?::(\d+))?$/

interface HostPort {
  readonly host: string
  readonly port: number
}

function parsePort(raw: string | undefined, input: string): number {
  if (raw === undefined) return DEFAULT_HUB_PORT
  const port = Number.parseInt(raw, 10)
  if (port < 1 || port > 65535) {
    throw new HubAddressError(`"${input}": port ${raw} is out of range (1-65535).`)
  }
  return port
}

function splitAuthority(authority: string, input: string): HostPort {
  const bracketed = BRACKETED.exec(authority)
  if (bracketed) return { host: `[${bracketed[1]}]`, port: parsePort(bracketed[2], input) }
  // A bare IPv6 literal (two or more colons) carries no port: brackets are needed for that.
  if ((authority.match(/:/g) ?? []).length >= 2) {
    return { host: `[${authority}]`, port: DEFAULT_HUB_PORT }
  }
  const plain = HOST_PORT.exec(authority)
  if (!plain) throw new HubAddressError(`"${input}" is not a hub address.`)
  return { host: plain[1]!, port: parsePort(plain[2], input) }
}

/**
 * `https://<host>:<port>` (default port 4443, scheme https, lower-case host,
 * no path or trailing slash). Throws {@link HubAddressError} on an empty value,
 * an `http://` or other scheme, a bad port or an unparsable host.
 */
export function normalizeHubAddress(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '') throw new HubAddressError('The hub address is empty.')
  const scheme = SCHEME.exec(trimmed)
  if (scheme) {
    const name = scheme[1]!.toLowerCase()
    if (name === 'http') {
      throw new HubAddressError(
        `"${trimmed}": the hub API is https. Use https://<host>:${DEFAULT_HUB_PORT} (or just <host>).`,
      )
    }
    if (name !== 'https') {
      throw new HubAddressError(`"${trimmed}": unsupported scheme "${name}", the hub API is https.`)
    }
  }
  const rest = scheme ? trimmed.slice(scheme[0].length) : trimmed
  const authority = rest.split(/[/?#]/, 1)[0] ?? ''
  if (authority === '' || authority.includes('@')) {
    throw new HubAddressError(`"${trimmed}" is not a hub address (expected host[:port]).`)
  }
  const { host, port } = splitAuthority(authority, trimmed)
  let hostname: string
  try {
    hostname = new URL(`https://${host}`).hostname
  } catch {
    throw new HubAddressError(`"${trimmed}": "${host}" is not a valid host name or address.`)
  }
  return `https://${hostname}:${port}`
}

/** {@link normalizeHubAddress} for a prompt validator: the message, or `undefined` when valid. */
export function validateHubAddress(input: string): string | undefined {
  try {
    normalizeHubAddress(input)
    return undefined
  } catch (err) {
    return err instanceof HubAddressError ? err.message : String(err)
  }
}
