/**
 * Name constraints of the hub's generated local CA (D873).
 *
 * An unconstrained private CA vouches for EVERY site on the internet to any
 * device that trusts it, so a leaked CA key would let its holder impersonate
 * a bank. The generated CA therefore carries a CRITICAL `nameConstraints`
 * extension (RFC 5280 4.2.1.10) that limits what it can ever certify to the
 * private address space and local-only names. A verifier that does not
 * understand a critical extension must reject the certificate, so the
 * constraint cannot be silently ignored by a conforming client.
 *
 * Pure: no filesystem, no clock. `cert-issue.ts` embeds the extension,
 * `cert-manager.ts` filters leaf names through {@link permitsIdentity}.
 */
import { isIP } from 'node:net'
import { AsnConvert } from '@peculiar/asn1-schema'
import { GeneralName, GeneralSubtree, GeneralSubtrees, NameConstraints } from '@peculiar/asn1-x509'
import { Extension, type X509Certificate as PeculiarCertificate } from '@peculiar/x509'
import type { CertIdentity } from './cert-identity.js'

/** `id-ce-nameConstraints`. */
export const NAME_CONSTRAINTS_OID = '2.5.29.30'

/** The address space the generated CA may certify. 100.64.0.0/10 is CGNAT, which Tailscale hands out. Loopback is for the hub's own `127.0.0.1` / `::1` SANs. */
export const PERMITTED_IP_RANGES: readonly string[] = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '127.0.0.0/8',
  'fc00::/7',
  '::1/128',
]

/**
 * Local-only DNS suffixes: none of them is delegated in public DNS. A leading
 * dot permits every name under the suffix and not the suffix itself.
 */
export const PERMITTED_DNS_SUFFIXES: readonly string[] = [
  '.local',
  '.lan',
  '.home.arpa',
  '.internal',
  '.localdomain',
  'localhost',
]

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i

/** A name that cannot collide with public DNS: a single label, or under a local-only suffix. */
export function isLocalOnlyHostname(name: string): boolean {
  const lower = name.toLowerCase()
  if (lower.length === 0 || lower.length > 253) return false
  if (!lower.includes('.')) return LABEL_RE.test(lower)
  const localSuffix = PERMITTED_DNS_SUFFIXES.some(
    (suffix) => suffix.startsWith('.') && lower.endsWith(suffix),
  )
  if (!localSuffix) return false
  return lower.split('.').every((label) => LABEL_RE.test(label))
}

/** What a CA may certify, as read from (or written into) its extension. */
export interface NameConstraintSet {
  /** `ip/prefix` strings. */
  readonly ipRanges: readonly string[]
  /** Lower-cased DNS constraints: `.suffix` for a subtree, a bare name for the name and its subdomains. */
  readonly dnsNames: readonly string[]
  readonly critical: boolean
}

/**
 * The constraint set for a new CA. `hostnames` are the hub's own local-only
 * names at creation time (a single-label OS hostname has no suffix to hide
 * under), added as exact entries; anything that could collide with public DNS
 * is dropped here, never constrained in.
 */
export function buildNameConstraintSet(hostnames: readonly string[]): NameConstraintSet {
  const dns = new Set<string>(PERMITTED_DNS_SUFFIXES)
  for (const name of hostnames) {
    const lower = name.trim().toLowerCase()
    if (isIP(lower) === 0 && isLocalOnlyHostname(lower)) dns.add(lower)
  }
  return { ipRanges: PERMITTED_IP_RANGES, dnsNames: [...dns], critical: true }
}

/** The `nameConstraints` extension for a CA: permitted subtrees only, marked critical. */
export function createNameConstraintsExtension(set: NameConstraintSet): Extension {
  const subtrees: GeneralSubtree[] = [
    ...set.ipRanges.map(
      (range) => new GeneralSubtree({ base: new GeneralName({ iPAddress: range }) }),
    ),
    ...set.dnsNames.map((name) => new GeneralSubtree({ base: new GeneralName({ dNSName: name }) })),
  ]
  const value = AsnConvert.serialize(
    new NameConstraints({ permittedSubtrees: new GeneralSubtrees(subtrees) }),
  )
  return new Extension(NAME_CONSTRAINTS_OID, set.critical, value)
}

/** The CA's constraint set, or `null` when the certificate carries no `nameConstraints`. */
export function readNameConstraints(cert: PeculiarCertificate): NameConstraintSet | null {
  const ext = cert.extensions.find((e) => e.type === NAME_CONSTRAINTS_OID)
  if (ext === undefined) return null
  const parsed = AsnConvert.parse(ext.value, NameConstraints)
  const ipRanges: string[] = []
  const dnsNames: string[] = []
  for (const subtree of parsed.permittedSubtrees ?? []) {
    if (subtree.base.iPAddress !== undefined) ipRanges.push(subtree.base.iPAddress)
    if (subtree.base.dNSName !== undefined) dnsNames.push(subtree.base.dNSName.toLowerCase())
  }
  return { ipRanges, dnsNames, critical: ext.critical }
}

/**
 * True when a CA is safe to keep as the hub's anchor: constrained to a
 * non-empty permitted set AND marked critical. A non-critical constraint is
 * ignored by clients that do not know the extension, which is the same as none.
 */
export function isConstrainedCa(cert: PeculiarCertificate): boolean {
  const set = readNameConstraints(cert)
  return set !== null && set.critical && (set.ipRanges.length > 0 || set.dnsNames.length > 0)
}

// ── Matching ─────────────────────────────────────────────────────────

function ipv4ToBigInt(address: string): bigint {
  return address.split('.').reduce((acc, octet) => (acc << 8n) | BigInt(Number(octet)), 0n)
}

function ipv6ToBigInt(address: string): bigint | null {
  const mapped = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(address)
  let text = address
  if (mapped !== null) {
    const v4 = ipv4ToBigInt(mapped[2] ?? '0.0.0.0')
    text = `${mapped[1] ?? ''}${((v4 >> 16n) & 0xffffn).toString(16)}:${(v4 & 0xffffn).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = (halves[0] ?? '') === '' ? [] : (halves[0] ?? '').split(':')
  const tail = halves.length === 2 && (halves[1] ?? '') !== '' ? (halves[1] ?? '').split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail]
  return groups.reduce((acc, group) => (acc << 16n) | BigInt(Number.parseInt(group, 16)), 0n)
}

function toBigInt(address: string): { readonly value: bigint; readonly bits: number } | null {
  const family = isIP(address)
  if (family === 4) return { value: ipv4ToBigInt(address), bits: 32 }
  if (family === 6) {
    const value = ipv6ToBigInt(address)
    return value === null ? null : { value, bits: 128 }
  }
  return null
}

function ipInRange(address: string, range: string): boolean {
  const [base, prefixText] = range.split('/')
  if (base === undefined || prefixText === undefined) return false
  const target = toBigInt(address)
  const net = toBigInt(base)
  const prefix = Number(prefixText)
  if (target === null || net === null || target.bits !== net.bits) return false
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > net.bits) return false
  const shift = BigInt(net.bits - prefix)
  return target.value >> shift === net.value >> shift
}

/** RFC 5280 DNS matching: a leading dot is a strict subtree, a bare name is itself and everything under it. */
function dnsPermitted(name: string, constraint: string): boolean {
  const lower = name.toLowerCase()
  if (constraint.startsWith('.')) return lower.endsWith(constraint)
  return lower === constraint || lower.endsWith(`.${constraint}`)
}

/** Is this SAN value (an IP literal or a DNS name) inside the permitted set? */
export function permitsName(set: NameConstraintSet, value: string): boolean {
  if (isIP(value) !== 0) return set.ipRanges.some((range) => ipInRange(value, range))
  return set.dnsNames.some((constraint) => dnsPermitted(value, constraint))
}

export interface ConstrainedIdentity {
  readonly identity: CertIdentity
  /** SAN values the CA's constraints do not permit, dropped from the leaf. */
  readonly dropped: readonly string[]
}

/**
 * The part of an identity the CA is allowed to certify. A leaf naming
 * anything outside the constraints makes the WHOLE chain fail validation in
 * OpenSSL, so such names are dropped (and reported), never signed. The
 * required lists shrink the same way: otherwise a name the CA cannot certify
 * would count as a permanent SAN gap and reissue the leaf on every boot.
 */
export function permitsIdentity(
  set: NameConstraintSet,
  identity: CertIdentity,
): ConstrainedIdentity {
  const dropped = new Set<string>()
  const keep = (values: readonly string[]): readonly string[] =>
    values.filter((value) => {
      if (permitsName(set, value)) return true
      dropped.add(value)
      return false
    })
  return {
    identity: {
      dnsNames: keep(identity.dnsNames),
      ipAddresses: keep(identity.ipAddresses),
      requiredDnsNames: keep(identity.requiredDnsNames),
      requiredIpAddresses: keep(identity.requiredIpAddresses),
    },
    dropped: [...dropped],
  }
}
