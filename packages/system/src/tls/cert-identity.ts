/**
 * What names and addresses the hub's certificate has to answer for.
 *
 * Split out of `cert-manager.ts` because it is pure and because the
 * regeneration rule (D227) is decided entirely by the difference between
 * *this* and what the certificate on disk already carries.
 */
import { isIP } from 'node:net'
import * as os from 'node:os'

/** One address on one interface — the slice of `os.NetworkInterfaceInfo` this uses. */
export interface HostInterfaceAddress {
  readonly address: string
  readonly internal: boolean
}

/**
 * What the certificate needs to know about the machine it identifies.
 *
 * Injected rather than read, for the same reason `evaluateExistingCert`
 * takes `now` instead of calling `Date.now()`: a rule whose inputs are
 * ambient cannot be stated in a test, and a spec that reads the real
 * `os.hostname()` is a statement about the machine running it. The CI
 * runner and this laptop disagreed about both halves (D551).
 */
export interface HostFacts {
  readonly hostname: string
  readonly networkInterfaces: Readonly<Record<string, readonly HostInterfaceAddress[] | undefined>>
}

/** The real machine. The only place in `tls/` that touches `os`. */
export function systemHostFacts(): HostFacts {
  return { hostname: os.hostname(), networkInterfaces: os.networkInterfaces() }
}

/**
 * Names/addresses that go INTO the certificate, and the subset whose
 * absence forces a reissue.
 *
 * The two are deliberately different sizes. Everything plausible is
 * certified — costs nothing. Only a **stable** identity gates
 * regeneration (IPv4 + DNS + operator `extraSans`), because a gate that
 * fires on a rotating address rewrites the certificate on every boot,
 * which is a worse bug than the one the gate exists to fix. IPv6 never
 * gates — ULA proved as unstable as global SLAAC on the live hub.
 */
export interface CertIdentity {
  readonly dnsNames: readonly string[]
  readonly ipAddresses: readonly string[]
  readonly requiredDnsNames: readonly string[]
  readonly requiredIpAddresses: readonly string[]
}

export interface CertIdentityOptions {
  readonly commonName: string
  readonly extraSans: readonly string[]
  /** The machine being certified. Defaults to {@link systemHostFacts}. */
  readonly hostFacts?: HostFacts
}

/**
 * Interfaces whose addresses are certified but never gate a reissue:
 * container bridges, VPN tunnels and mesh overlays hand out addresses
 * that change without the hub moving.
 */
const VOLATILE_INTERFACE_PREFIXES: readonly string[] = [
  'docker',
  'br-',
  'veth',
  'virbr',
  'cni',
  'flannel',
  'tun',
  'utun',
  'tap',
  'wg',
  'zt',
  'tailscale',
  'ppp',
  'awdl',
  'llw',
]

/** A DNS name we are willing to put in a SAN. */
const DNS_NAME_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/

export function isIpv4(value: string): boolean {
  return isIP(value) === 4
}

export function isIpv6(value: string): boolean {
  return isIP(value) === 6
}

/**
 * `fe80::/10` and `169.254.0.0/16`. An IPv6 link-local address needs a
 * zone index to be usable and a SAN cannot carry one, so such an entry
 * can never match anything — it is noise that makes the certificate look
 * broader than it is.
 */
export function isLinkLocal(value: string): boolean {
  if (isIpv4(value)) return value.startsWith('169.254.')
  if (!isIpv6(value)) return false
  const firstGroup = value.split(':')[0] ?? ''
  if (firstGroup === '') return false
  const parsed = Number.parseInt(firstGroup, 16)
  return Number.isFinite(parsed) && (parsed & 0xffc0) === 0xfe80
}

/** `fc00::/7` — the IPv6 range that behaves like RFC 1918 does for v4. */
export function isUniqueLocalIpv6(value: string): boolean {
  if (!isIpv6(value)) return false
  const firstGroup = value.split(':')[0] ?? ''
  const parsed = Number.parseInt(firstGroup, 16)
  return Number.isFinite(parsed) && (parsed & 0xfe00) === 0xfc00
}

function isVolatileInterface(name: string): boolean {
  const lower = name.toLowerCase()
  return VOLATILE_INTERFACE_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

/**
 * Only IPv4 gates a reissue. Every IPv6 address we see — global **or**
 * ULA — is certified but never required: `os` cannot tell a temporary
 * address from a permanent one, and the live hub's ULA interface-id
 * rotated on every restart (eight leaf reissues in one day under
 * `san-coverage-gap`). Gating on ULA reproduced the churn D227 exists
 * to prevent. Operators who need a fixed IPv6 declare it via `extraSans`.
 */
function isStableGateAddress(address: string): boolean {
  if (isLinkLocal(address)) return false
  return isIpv4(address)
}

function addSan(dns: Set<string>, ips: Set<string>, value: string): void {
  const trimmed = value.trim()
  if (trimmed === '') return
  if (isIP(trimmed) !== 0) {
    if (!isLinkLocal(trimmed)) ips.add(trimmed)
    return
  }
  if (DNS_NAME_PATTERN.test(trimmed)) dns.add(trimmed)
}

/**
 * Snapshot the machine's identity. Called once per `ensureTlsCert`; the
 * result is both the SAN list for a new leaf and the yardstick the
 * existing leaf is measured against.
 */
export function collectCertIdentity(options: CertIdentityOptions): CertIdentity {
  const host = options.hostFacts ?? systemHostFacts()
  const dnsNames = new Set<string>()
  const ipAddresses = new Set<string>(['127.0.0.1', '::1'])
  const requiredDnsNames = new Set<string>()
  const requiredIpAddresses = new Set<string>(['127.0.0.1'])

  for (const name of ['localhost', options.commonName, host.hostname]) {
    addSan(dnsNames, ipAddresses, name)
    addSan(requiredDnsNames, requiredIpAddresses, name)
  }

  for (const [ifaceName, addrs] of Object.entries(host.networkInterfaces)) {
    for (const addr of addrs ?? []) {
      if (addr.internal) continue
      if (isLinkLocal(addr.address)) continue
      ipAddresses.add(addr.address)
      if (isVolatileInterface(ifaceName)) continue
      if (isStableGateAddress(addr.address)) requiredIpAddresses.add(addr.address)
    }
  }

  // Operator-declared SANs are required by definition — they were asked for.
  for (const san of options.extraSans) {
    addSan(dnsNames, ipAddresses, san)
    addSan(requiredDnsNames, requiredIpAddresses, san)
  }

  return {
    dnsNames: [...dnsNames],
    ipAddresses: [...ipAddresses],
    requiredDnsNames: [...requiredDnsNames],
    requiredIpAddresses: [...requiredIpAddresses],
  }
}
