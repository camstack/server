/**
 * HTTPS for agents (D856): a leaf from the hub's LOCAL CA, so a device that
 * trusts the hub root trusts the agents too.
 *
 * The agent generates its key and a CSR; the hub signs only the PUBLIC key under
 * the local CA and returns the certificate - no private key ever crosses the mesh.
 * The agent keeps ONE file, `tls/agent-https.json` (0600: key + leaf + the pinned CA),
 * written atomically (temp file + rename) so a crash can never leave a key that does
 * not match its certificate. It persists no database.
 *
 * What the hub is willing to certify (the smaller safe option). The local CA is trusted
 * by every device that trusts the hub, so a compromised agent must not obtain a name it
 * does not own. The hub signs ONLY what it knows by itself:
 *   - the agent's node id (unique in the cluster), when it is a local-only name;
 *   - the remote address of the agent's LIVE mesh socket as the hub sees it, when it is
 *     a private address - never an address the agent reports.
 * Anything the agent reports (host names, interface addresses) is DROPPED and logged:
 * extra self-reported names would need an explicit operator approval flow, which does
 * not exist, so they are not certified. A name the hub's own certificate holds, or one
 * already certified to another node, is never signed (a NAT'd pair of agents would
 * otherwise share an address).
 */
import { createHash, createPrivateKey, webcrypto, X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'
import type { HttpsLeafInfo } from '@camstack/types'
import { writeOwnerOnlyFileSync } from '@camstack/types/node'
import { cryptoProvider, PemConverter, Pkcs10CertificateRequestGenerator } from '@peculiar/x509'
import { MAX_LEAF_VALIDITY_DAYS } from './cert-evaluation.js'
import { type CertIdentity, collectCertIdentity, type HostFacts } from './cert-identity.js'
import { issueLeafFromCsr, loadCa } from './cert-issue.js'
import {
  isLocalOnlyHostname,
  permitsIdentity,
  readNameConstraints,
} from './cert-name-constraints.js'

cryptoProvider.set(webcrypto)

export interface AgentHttpsPaths {
  readonly dir: string
  /** The one atomic file: key + leaf + pinned CA. */
  readonly bundlePath: string
  /** Informational copy of the leaf (public), written after the bundle. */
  readonly certPath: string
  readonly pendingKeyPath: string
}

export function agentHttpsPaths(dataDir: string): AgentHttpsPaths {
  const dir = join(dataDir, 'tls')
  return {
    dir,
    bundlePath: join(dir, 'agent-https.json'),
    certPath: join(dir, 'agent.crt'),
    pendingKeyPath: join(dir, 'agent.key.pending'),
  }
}

export interface AgentHttpsMaterial {
  readonly keyPem: string
  readonly certPem: string
  readonly caCertPem: string
}

/**
 * The material on disk, or `null` while no hub-issued leaf is installed. A bundle that
 * cannot be parsed is reported through `onCorrupt` and treated as absent: a bad file must
 * never take the agent API down.
 */
export function loadAgentHttps(
  dataDir: string,
  onCorrupt?: (reason: string) => void,
): AgentHttpsMaterial | null {
  const { bundlePath } = agentHttpsPaths(dataDir)
  if (!existsSync(bundlePath)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(bundlePath, 'utf8'))
    const field = (name: string): string | null => {
      const v: unknown =
        parsed !== null && typeof parsed === 'object' ? Reflect.get(parsed, name) : null
      return typeof v === 'string' && v.length > 0 ? v : null
    }
    const keyPem = field('keyPem')
    const certPem = field('certPem')
    const caCertPem = field('caCertPem')
    if (keyPem === null || certPem === null || caCertPem === null) {
      onCorrupt?.('the bundle is missing a field')
      return null
    }
    // The pair must belong together; a mismatch is as bad as a missing file.
    if (!new X509Certificate(certPem).checkPrivateKey(createPrivateKey(keyPem))) {
      onCorrupt?.('the certificate does not match the key')
      return null
    }
    return { keyPem, certPem, caCertPem }
  } catch (error: unknown) {
    onCorrupt?.(error instanceof Error ? error.message : String(error))
    return null
  }
}

/** What an agent reports about itself for its certificate. */
export interface AgentNames {
  readonly hostnames: readonly string[]
  readonly addresses: readonly string[]
}

export function collectAgentNames(nodeId: string, hostFacts: HostFacts): AgentNames {
  const identity = collectCertIdentity({ commonName: nodeId, extraSans: [], hostFacts })
  return { hostnames: identity.dnsNames, addresses: identity.ipAddresses }
}

export interface AgentHttpsRequest extends AgentNames {
  readonly csrPem: string
}

/** SHA-256 of the hub local CA this agent pinned, or `null` while none is. */
export function pinnedHttpsCaFingerprint(dataDir: string): string | null {
  const material = loadAgentHttps(dataDir)
  return material === null ? null : new X509Certificate(material.caCertPem).fingerprint256
}

/**
 * A fresh key pair (EC P-256, kept in `agent.key.pending`, 0600) and its CSR. The
 * key becomes `agent.key` only when the matching certificate is installed, so a
 * request that is never answered changes nothing that is being served.
 */
export async function createAgentHttpsRequest(
  dataDir: string,
  nodeId: string,
  names: AgentNames,
): Promise<AgentHttpsRequest> {
  const paths = agentHttpsPaths(dataDir)
  mkdirSync(paths.dir, { recursive: true })
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const csr = await Pkcs10CertificateRequestGenerator.create({
    name: `CN=${nodeId}`,
    keys,
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
  })
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)
  writeOwnerOnlyFileSync(paths.pendingKeyPath, `${PemConverter.encode(pkcs8, 'PRIVATE KEY')}\n`)
  return { csrPem: `${csr.toString('pem')}\n`, ...names }
}

export class AgentHttpsInstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentHttpsInstallError'
  }
}

/**
 * Install the hub-signed leaf for the pending key. Refused when it is not for that key, when
 * it is not signed by the CA it came with, or - once a CA is pinned - when that CA is not the
 * one this agent already pinned (the CA that arrives with a later leaf is never trusted on its
 * own say: the first one came over the authenticated mesh, every later leaf must chain to it).
 * Key, leaf and CA are written as ONE file, atomically.
 */
export function installAgentHttps(
  dataDir: string,
  input: {
    readonly certPem: string
    readonly caCertPem: string
    /**
     * The hub says its local CA was rotated and this leaf chains to the new one. Honoured only
     * because the install call itself arrived over the authenticated mesh from the hub; without
     * it a different CA is refused.
     */
    readonly caRotation?: boolean
  },
): AgentHttpsMaterial {
  const paths = agentHttpsPaths(dataDir)
  if (!existsSync(paths.pendingKeyPath)) {
    throw new AgentHttpsInstallError('no pending key: prepareHttpsCertificate was not called')
  }
  const keyPem = readFileSync(paths.pendingKeyPath, 'utf8')
  let leaf: X509Certificate
  let ca: X509Certificate
  try {
    leaf = new X509Certificate(input.certPem)
    ca = new X509Certificate(input.caCertPem)
  } catch {
    throw new AgentHttpsInstallError('the certificate or the CA is not a valid PEM certificate')
  }
  if (!leaf.checkPrivateKey(createPrivateKey(keyPem))) {
    throw new AgentHttpsInstallError("the certificate is not for this node's pending key")
  }
  const pinned = loadAgentHttps(dataDir)
  if (pinned !== null && input.caRotation !== true) {
    const pinnedCa = new X509Certificate(pinned.caCertPem)
    if (pinnedCa.fingerprint256 !== ca.fingerprint256 || !leaf.verify(pinnedCa.publicKey)) {
      throw new AgentHttpsInstallError(
        'the leaf does not chain to the hub local CA this agent pinned at its first install ' +
          '(if the hub rotated its local CA, renew HTTPS from the hub - it signals the rotation)',
      )
    }
  }
  if (!leaf.verify(ca.publicKey)) {
    throw new AgentHttpsInstallError('the certificate is not signed by the CA that came with it')
  }
  if (new Date(leaf.validTo).getTime() <= Date.now()) {
    throw new AgentHttpsInstallError('the certificate is already expired')
  }
  mkdirSync(paths.dir, { recursive: true })
  // Atomic (temp + rename) and owner-only on every platform: the helper
  // restricts the empty temp file (0600 / owner ACL) before the key is written.
  writeOwnerOnlyFileSync(
    paths.bundlePath,
    JSON.stringify({ keyPem, certPem: input.certPem, caCertPem: input.caCertPem }),
  )
  // Public, informational: after the bundle, so a crash here changes nothing that is served.
  writeFileAtomic(
    paths.certPath,
    input.certPem.endsWith('\n') ? input.certPem : `${input.certPem}\n`,
  )
  return { keyPem, certPem: input.certPem, caCertPem: input.caCertPem }
}

function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}

/** Fingerprint, issuer, SANs and validity of a served leaf. */
export function describeHttpsLeaf(certPem: string): HttpsLeafInfo {
  const x509 = new X509Certificate(certPem)
  return {
    fingerprintSha256: x509.fingerprint256,
    issuer: x509.issuer.replaceAll('\n', ', '),
    sans: (x509.subjectAltName ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    notBefore: Date.parse(x509.validFrom),
    notAfter: Date.parse(x509.validTo),
  }
}

// ── What the hub will certify ────────────────────────────────────────

/** Private-network IPv4/IPv6: RFC 1918, CGNAT (Tailscale), link-local, ULA. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number]
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254)
    )
  }
  if (family === 6) {
    const lower = address.toLowerCase()
    return lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:')
  }
  return false
}

/** The default docker bridge network (172.17.0.0/16): identical on every host, so it names nothing. */
export function isContainerBridgeAddress(address: string): boolean {
  return /^172\.17\.\d{1,3}\.\d{1,3}$/.test(address)
}

export { isLocalOnlyHostname }

export interface AcceptedSans {
  readonly identity: CertIdentity
  readonly accepted: readonly string[]
  readonly rejected: readonly string[]
}

/**
 * The names the hub will sign for `nodeId`: its node id and the address of its live mesh
 * socket - nothing the agent says about itself. `excluded` holds every name already taken
 * (the hub's own certificate, other nodes' leaves); `reported` is what the agent claimed,
 * listed only so it can be logged as dropped.
 */
export function acceptAgentSans(input: {
  readonly nodeId: string
  /** The remote address of the agent's live mesh socket, as the HUB sees it. */
  readonly observedAddress?: string | undefined
  readonly excluded?: ReadonlySet<string>
  readonly reported?: readonly string[]
}): AcceptedSans {
  const excluded = input.excluded ?? new Set<string>()
  const taken = (name: string): boolean => excluded.has(name.toLowerCase())
  const rejected: string[] = (input.reported ?? []).map(
    (n) => `${n} (self-reported, not certified)`,
  )
  const dns: string[] = []
  const ips: string[] = []
  const id = input.nodeId.toLowerCase()
  if (id !== 'hub' && isLocalOnlyHostname(id) && !taken(id)) dns.push(id)
  else rejected.push(`${input.nodeId} (node id: not a usable name)`)
  const address = input.observedAddress?.replace(/^::ffff:/, '')
  if (address !== undefined) {
    if (address.includes('%')) {
      rejected.push(`${address} (observed address: zone-scoped, only the node id is certified)`)
    } else if (isContainerBridgeAddress(address)) {
      // The default docker bridge is the same on every host: it names no node. (The hub's OWN
      // bridge gateway is in the hub certificate's names, so it is excluded above.)
      rejected.push(
        `${address} (observed address: a container bridge address, only the node id is certified)`,
      )
    } else if (isIP(address) !== 0 && isPrivateAddress(address) && !taken(address)) {
      ips.push(address)
    } else {
      rejected.push(`${address} (observed address: not private or already certified)`)
    }
  }
  return {
    identity: {
      dnsNames: dns,
      ipAddresses: ips,
      requiredDnsNames: dns,
      requiredIpAddresses: ips,
    },
    accepted: [...dns, ...ips],
    rejected,
  }
}

/** The SAN values (lower-cased) of a certificate PEM: DNS names and IP addresses. */
export function certificateNames(certPem: string): ReadonlySet<string> {
  const names = new Set<string>()
  const san = new X509Certificate(certPem).subjectAltName ?? ''
  for (const part of san.split(',')) {
    const [, value] = part.trim().split(/:(.*)/s)
    if (value !== undefined && value.length > 0) names.add(value.toLowerCase())
  }
  return names
}

export interface IssuedAgentHttps {
  readonly certPem: string
  readonly caCertPem: string
  readonly accepted: readonly string[]
  readonly rejected: readonly string[]
}

/**
 * Hub side: sign an agent's CSR under the local CA in `<hubDataDir>/tls`. Throws when
 * there is no local CA to sign with or no name survives the policy.
 */
export async function issueAgentHttpsLeaf(input: {
  readonly hubDataDir: string
  readonly nodeId: string
  readonly csrPem: string
  /** What the agent reported. Never certified; only logged as dropped. */
  readonly reportedNames?: readonly string[]
  /** The remote address of the agent's live mesh socket, from the hub's own view. */
  readonly observedAddress?: string | undefined
  /** Names already certified to OTHER nodes. */
  readonly takenByOthers?: ReadonlySet<string>
  readonly now?: Date
}): Promise<IssuedAgentHttps> {
  const caCertPath = join(input.hubDataDir, 'tls', 'camstack-ca.crt')
  const caKeyPath = join(input.hubDataDir, 'tls', 'camstack-ca.key')
  const hubLeafPath = join(input.hubDataDir, 'tls', 'camstack.crt')
  if (!existsSync(caCertPath) || !existsSync(caKeyPath)) {
    throw new Error('the hub has no local CA to sign with (no tls/camstack-ca.crt + key)')
  }
  // Never a name the hub's own certificate holds, nor one another node already has.
  const excluded = new Set<string>(input.takenByOthers ?? [])
  if (existsSync(hubLeafPath)) {
    for (const name of certificateNames(readFileSync(hubLeafPath, 'utf8'))) excluded.add(name)
  }
  const ca = await loadCa(readFileSync(caCertPath, 'utf8'), readFileSync(caKeyPath, 'utf8'))
  const policy = acceptAgentSans({
    nodeId: input.nodeId,
    observedAddress: input.observedAddress,
    excluded,
    ...(input.reportedNames !== undefined ? { reported: input.reportedNames } : {}),
  })
  // A leaf naming anything outside the CA's name constraints (D873) fails validation as a
  // whole, so such a name is dropped here and reported like any other refused name.
  const constraints = readNameConstraints(ca.cert)
  const constrained = constraints === null ? null : permitsIdentity(constraints, policy.identity)
  const sans =
    constrained === null
      ? policy
      : {
          identity: constrained.identity,
          accepted: policy.accepted.filter((name) => !constrained.dropped.includes(name)),
          rejected: [
            ...policy.rejected,
            ...constrained.dropped.map(
              (name) => `${name} (outside the local CA's name constraints)`,
            ),
          ],
        }
  if (sans.accepted.length === 0) {
    throw new Error(
      `no name of node '${input.nodeId}' can be certified (${sans.rejected.join('; ') || 'nothing offered'})`,
    )
  }
  const certPem = await issueLeafFromCsr(
    ca,
    input.csrPem,
    sans.identity,
    input.nodeId,
    MAX_LEAF_VALIDITY_DAYS,
    input.now ?? new Date(),
  )
  return { certPem, caCertPem: ca.certPem, accepted: sans.accepted, rejected: sans.rejected }
}

/** SHA-256 of a PEM (for logs that must not print a certificate). */
export function pemDigest(pem: string): string {
  return createHash('sha256').update(pem).digest('hex').slice(0, 16)
}
