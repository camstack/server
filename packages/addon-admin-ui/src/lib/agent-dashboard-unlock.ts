/**
 * Client half of D821 — mint an unlock ticket and open the agent's `:4444`
 * dashboard. `addons.custom` is `unknown` at the cap boundary, so the mint
 * reply is narrowed here (no casts). The host for the URL prefers the
 * operator-written reachable host over the first advertised IPv4.
 */

export interface MintUnlockView {
  readonly ticket: string
  readonly dashboardUrl?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrow `addons.custom` mintAgentUiUnlockTicket answer, or `null`. */
export function parseMintUnlockResult(raw: unknown): MintUnlockView | null {
  if (!isRecord(raw)) return null
  const ticket = raw['ticket']
  if (typeof ticket !== 'string' || ticket.length === 0) return null
  const dashboardUrl = raw['dashboardUrl']
  if (typeof dashboardUrl === 'string' && dashboardUrl.length > 0) {
    return { ticket, dashboardUrl }
  }
  return { ticket }
}

/** True for a host string safe to put in `http://{host}:4444/`. */
export function isAgentDashboardHost(host: string): boolean {
  const t = host.trim()
  if (t.length === 0) return false
  if (t.includes('/') || t.includes('?') || t.includes('#') || t.includes('@')) return false
  if (t.includes(':')) return false
  return true
}

/** Docker default bridge — reachable from the host, not from the operator LAN. */
function isDockerBridgeIpv4(ip: string): boolean {
  return ip.startsWith('172.17.')
}

/** Tailscale / CGNAT — fine on the tailnet, often dead from a plain LAN browser. */
function isCarrierGradeNatIpv4(ip: string): boolean {
  const m = /^100\.(\d+)\./.exec(ip)
  if (m === null) return false
  const second = Number(m[1])
  return second >= 64 && second <= 127
}

function isRfc1918LanIpv4(ip: string): boolean {
  if (ip.startsWith('10.')) return true
  if (ip.startsWith('192.168.')) return true
  const m = /^172\.(\d+)\./.exec(ip)
  if (m === null) return false
  const second = Number(m[1])
  return second >= 16 && second <= 31 && !isDockerBridgeIpv4(ip)
}

/**
 * Prefer the operator-written reachable host; else a LAN IPv4 from topology
 * (skip loopback, link-local, docker bridge, then CGNAT/Tailscale).
 */
export function pickAgentDashboardHost(
  localIps: readonly string[],
  reachableHost: string | null | undefined,
): string | null {
  if (typeof reachableHost === 'string' && isAgentDashboardHost(reachableHost)) {
    return reachableHost.trim()
  }
  const ipv4 = localIps.filter((ip) => !ip.includes(':'))
  const lan = ipv4.find(
    (ip) =>
      !ip.startsWith('127.') &&
      !ip.startsWith('169.254.') &&
      !isDockerBridgeIpv4(ip) &&
      !isCarrierGradeNatIpv4(ip) &&
      isRfc1918LanIpv4(ip),
  )
  if (lan !== undefined) return lan
  for (const ip of ipv4) {
    if (ip.startsWith('127.')) continue
    if (ip.startsWith('169.254.')) continue
    if (isDockerBridgeIpv4(ip)) continue
    return ip
  }
  return null
}

export function buildAgentDashboardBaseUrl(host: string): string {
  return `http://${host}:4444/`
}

export function buildAgentDashboardTicketUrl(host: string, ticket: string): string {
  const u = new URL(buildAgentDashboardBaseUrl(host))
  u.searchParams.set('ticket', ticket)
  return u.toString()
}

/**
 * Open a blank tab in the same user-gesture turn as the click. A later
 * `window.open` after `await` is popup-blocked; navigating this handle is not.
 */
export function openBlankDashboardTab(): Window | null {
  return window.open('about:blank', '_blank')
}

/** Navigate a tab opened by {@link openBlankDashboardTab}, or return false. */
export function navigateDashboardTab(tab: Window | null, url: string): boolean {
  if (tab === null || tab.closed) return false
  tab.location.href = url
  return true
}
