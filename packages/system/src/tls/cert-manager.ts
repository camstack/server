import { X509Certificate } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { X509Certificate as PeculiarCertificate } from '@peculiar/x509'
import { writeOwnerOnlyFileSync } from '@camstack/types/node'
import type { CertRegenerationReason } from './cert-evaluation.js'
import {
  evaluateExistingCert,
  MAX_LEAF_VALIDITY_DAYS,
  reasonRequiresNewCa,
} from './cert-evaluation.js'
import type { CertIdentity, HostFacts } from './cert-identity.js'
import { collectCertIdentity } from './cert-identity.js'
import type { CaSigner } from './cert-issue.js'
import { generateCa, issueLeaf, loadCa, localCaCommonName } from './cert-issue.js'
import { isConstrainedCa, permitsIdentity, readNameConstraints } from './cert-name-constraints.js'

export interface TlsCertPair {
  readonly cert: Buffer
  readonly key: Buffer
}

export interface EnsureTlsResult {
  /** Full chain — leaf then CA. This is what the listener serves. */
  readonly certPath: string
  /** The leaf's private key. */
  readonly keyPath: string
  /** The local root. **This** is the file an operator installs as trusted. */
  readonly caCertPath: string
  readonly caKeyPath: string
  readonly generated: boolean
  /** Why it was reissued — `null` when the existing material was kept. */
  readonly reason: CertRegenerationReason | null
  /** True when the ROOT rotated, i.e. trust granted by hand is now void. */
  readonly caRotated: boolean
  readonly fingerprintSha256: string
  readonly caFingerprintSha256: string
  /** Fingerprint of the leaf this one replaced — `null` on a fresh install. */
  readonly previousFingerprintSha256: string | null
  /** ISO timestamp at which the leaf stops being valid. */
  readonly validTo: string
  readonly sans: readonly string[]
  /**
   * SAN values the local CA's name constraints (D873) do not permit, left out of the
   * leaf. Empty when everything the machine answers to is certifiable.
   */
  readonly droppedNames: readonly string[]
  /**
   * Set when a reissue was needed and FAILED, and the previous material is
   * still being served. Never null-and-degraded silently: this is the line
   * that says the certificate is not what the rule wants it to be.
   */
  readonly reissueError: string | null
}

export interface CertOptions {
  /** Common Name for the leaf (default: 'camstack.local') */
  readonly commonName?: string
  /**
   * The hub's human name (D861). Read only when a NEW local root is created: its subject
   * becomes `CamStack Local CA — <hubName>` ({@link localCaCommonName}). An existing root
   * is never reissued because this changed. Absent: the plain `CamStack Local CA`.
   */
  readonly hubName?: string
  /** Leaf validity in days. Clamped to `MAX_LEAF_VALIDITY_DAYS`. */
  readonly validDays?: number
  /** Additional SANs (DNS names or IPs). Required coverage by definition. */
  readonly extraSans?: readonly string[]
  /**
   * The machine being certified. Defaults to the real one; injected by the
   * spec so the regeneration rule can be stated without reference to
   * whichever box happens to run it (D551).
   */
  readonly hostFacts?: HostFacts
}

const DEFAULT_COMMON_NAME = 'camstack.local'

/**
 * Ensure the hub has a usable TLS identity under `<dataDir>/tls`, made of
 * a long-lived local **root** (`camstack-ca.crt`) and a short **leaf**
 * chained to it (`camstack.crt` = leaf + root, `camstack.key`).
 *
 * ## The regeneration rule (D227)
 *
 * Reissue happens when, and only when, the material on disk **cannot do
 * its job**:
 *
 * - it is absent, unreadable, or the key does not match the certificate;
 * - the root is absent (every pre-2026-08 install: one self-signed
 *   `CA:TRUE` leaf and no root) or is inside its renewal window;
 * - the leaf is inside its 30-day renewal window;
 * - the leaf lacks `extendedKeyUsage = serverAuth` — Apple's trustd
 *   rejects an app-supplied anchor without it;
 * - the leaf is not actually issued by the root on disk;
 * - the leaf's validity span exceeds {@link MAX_LEAF_VALIDITY_DAYS};
 * - **a name or address the hub must answer for is missing from the SAN
 *   list** — a DHCP move, a new interface or a new hostname.
 *
 * And explicitly NOT when: the certificate names an address the machine
 * no longer has (a superset still works — the check is one-directional),
 * a volatile interface (docker/VPN/mesh) or **any** IPv6 address changed
 * (global and ULA both rotate under privacy extensions / interface-id
 * churn — `os` cannot tell temporary from permanent), or a new build shipped.
 *
 * Every trigger is derived from the files plus the machine, so once a
 * reissue clears them it clears them for good: the next boot returns
 * `generated: false`. A certificate that moved on every boot would
 * invalidate every trust an operator granted by hand — worse than the
 * bugs this rule fixes.
 *
 * **The root is rotated only for root-level reasons.** SAN drift rotates
 * the leaf alone, so trust granted to `camstack-ca.crt` survives every
 * address change the hub will ever see.
 */
export async function ensureTlsCert(
  dataDir: string,
  options?: CertOptions,
): Promise<EnsureTlsResult> {
  const tlsDir = join(dataDir, 'tls')
  const paths = {
    certPath: join(tlsDir, 'camstack.crt'),
    keyPath: join(tlsDir, 'camstack.key'),
    caCertPath: join(tlsDir, 'camstack-ca.crt'),
    caKeyPath: join(tlsDir, 'camstack-ca.key'),
  }

  const commonName = options?.commonName ?? DEFAULT_COMMON_NAME
  const validDays = Math.min(options?.validDays ?? MAX_LEAF_VALIDITY_DAYS, MAX_LEAF_VALIDITY_DAYS)
  const rawIdentity = collectCertIdentity({
    commonName,
    extraSans: options?.extraSans ?? [],
    ...(options?.hostFacts === undefined ? {} : { hostFacts: options.hostFacts }),
  })

  // The identity the CA ON DISK can certify; a name outside its constraints is not a SAN gap.
  const onDisk = constrainToDiskCa(paths, rawIdentity)
  const reason = decideRegeneration(paths, onDisk.identity)
  if (reason === null) {
    return describe(paths, false, null, false, null, null, onDisk.dropped)
  }

  const previousFingerprint = readFingerprint(paths.certPath)
  const caRotated = reasonRequiresNewCa(reason)
  mkdirSync(tlsDir, { recursive: true })
  let dropped: readonly string[] = []
  try {
    dropped = await regenerate(paths, rawIdentity, {
      commonName,
      caCommonName: localCaCommonName(options?.hubName),
      validDays,
      newCa: caRotated,
      reason,
    })
  } catch (err) {
    // Nothing here may take a booting hub down. If the previous material
    // still exists and still parses, keep serving it and SAY SO — a
    // degraded certificate beats no listener. With nothing to fall back
    // to, the failure is real and propagates.
    const message = err instanceof Error ? err.message : String(err)
    if (!canKeepServing(paths)) throw err
    return describe(paths, false, null, false, null, message, onDisk.dropped)
  }
  return describe(paths, true, reason, caRotated, previousFingerprint, null, dropped)
}

/**
 * Operator "Regenerate": issue a new leaf under the existing local CA.
 * Never rotates the root — trust granted to `camstack-ca.crt` survives.
 */
export async function reissueTlsLeaf(
  dataDir: string,
  options?: CertOptions,
): Promise<EnsureTlsResult> {
  const tlsDir = join(dataDir, 'tls')
  const paths = {
    certPath: join(tlsDir, 'camstack.crt'),
    keyPath: join(tlsDir, 'camstack.key'),
    caCertPath: join(tlsDir, 'camstack-ca.crt'),
    caKeyPath: join(tlsDir, 'camstack-ca.key'),
  }
  if (!existsSync(paths.caCertPath) || !existsSync(paths.caKeyPath)) {
    return ensureTlsCert(dataDir, options)
  }
  const commonName = options?.commonName ?? DEFAULT_COMMON_NAME
  const validDays = Math.min(options?.validDays ?? MAX_LEAF_VALIDITY_DAYS, MAX_LEAF_VALIDITY_DAYS)
  const identity = collectCertIdentity({
    commonName,
    extraSans: options?.extraSans ?? [],
    ...(options?.hostFacts === undefined ? {} : { hostFacts: options.hostFacts }),
  })
  const previousFingerprint = readFingerprint(paths.certPath)
  mkdirSync(tlsDir, { recursive: true })
  const dropped = await regenerate(paths, identity, {
    commonName,
    caCommonName: localCaCommonName(options?.hubName),
    validDays,
    newCa: false,
    reason: null,
  })
  return describe(paths, true, 'san-coverage-gap', false, previousFingerprint, null, dropped)
}

/**
 * Uploaded mode keeps a generated CA beside the upload (agents' leaves are still signed
 * by it). When that CA is unconstrained, replace it alone (D873): the served pair is the
 * operator's and is never touched. Returns whether the CA was replaced.
 */
export async function replaceUnconstrainedLocalCa(
  dataDir: string,
  options?: CertOptions,
): Promise<boolean> {
  const tlsDir = join(dataDir, 'tls')
  const paths = {
    certPath: join(tlsDir, 'camstack.crt'),
    keyPath: join(tlsDir, 'camstack.key'),
    caCertPath: join(tlsDir, 'camstack-ca.crt'),
    caKeyPath: join(tlsDir, 'camstack-ca.key'),
  }
  if (!existsSync(paths.caCertPath) || !existsSync(paths.caKeyPath)) return false
  try {
    if (isConstrainedCa(new PeculiarCertificate(readFileSync(paths.caCertPath, 'utf-8')))) {
      return false
    }
  } catch {
    return false
  }
  const identity = collectCertIdentity({
    commonName: options?.commonName ?? DEFAULT_COMMON_NAME,
    extraSans: options?.extraSans ?? [],
    ...(options?.hostFacts === undefined ? {} : { hostFacts: options.hostFacts }),
  })
  const ca = await generateCa(new Date(), identity.dnsNames, localCaCommonName(options?.hubName))
  archivePreviousCa(paths, ca)
  await writeFile(`${paths.caCertPath}.new`, ca.certPem, 'utf-8')
  writeOwnerOnlyFileSync(`${paths.caKeyPath}.new`, ca.keyPem)
  renameSync(`${paths.caCertPath}.new`, paths.caCertPath)
  renameSync(`${paths.caKeyPath}.new`, paths.caKeyPath)
  return true
}

/** True when the material already on disk can still terminate TLS. */
function canKeepServing(paths: CertPaths): boolean {
  if (!existsSync(paths.certPath) || !existsSync(paths.keyPath)) return false
  if (!existsSync(paths.caCertPath)) return false
  return readFingerprint(paths.certPath) !== null
}

/** Fingerprint of whatever is on disk, or `null` if there is nothing readable. */
function readFingerprint(certPath: string): string | null {
  try {
    return new X509Certificate(readFileSync(certPath)).fingerprint256
  } catch {
    return null
  }
}

interface CertPaths {
  readonly certPath: string
  readonly keyPath: string
  readonly caCertPath: string
  readonly caKeyPath: string
}

function decideRegeneration(
  paths: CertPaths,
  identity: CertIdentity,
): CertRegenerationReason | null {
  if (!existsSync(paths.certPath) || !existsSync(paths.keyPath)) return 'missing'
  if (!existsSync(paths.caCertPath) || !existsSync(paths.caKeyPath)) return 'no-local-ca'
  try {
    return evaluateExistingCert({
      chainPem: readFileSync(paths.certPath, 'utf-8'),
      keyPem: readFileSync(paths.keyPath, 'utf-8'),
      caPem: readFileSync(paths.caCertPath, 'utf-8'),
      identity,
      now: new Date(),
    })
  } catch {
    return 'unreadable'
  }
}

/**
 * Build every byte in memory, then move the files into place. A crash
 * mid-way leaves the previous material untouched; a crash between the
 * moves leaves a key/certificate mismatch, which the evaluator reports as
 * `key-mismatch` and heals on the next boot.
 */
interface RegenerateParams {
  /** The leaf's CN. */
  readonly commonName: string
  /** The subject CN a NEW root gets; unused when the root on disk is kept. */
  readonly caCommonName: string
  readonly validDays: number
  readonly newCa: boolean
  readonly reason: CertRegenerationReason | null
}

async function regenerate(
  paths: CertPaths,
  rawIdentity: CertIdentity,
  params: RegenerateParams,
): Promise<readonly string[]> {
  const { commonName, caCommonName, validDays, newCa, reason } = params
  const now = new Date()
  const ca: CaSigner = newCa
    ? await generateCa(now, rawIdentity.dnsNames, caCommonName)
    : await loadCa(readFileSync(paths.caCertPath, 'utf-8'), readFileSync(paths.caKeyPath, 'utf-8'))
  const constraints = readNameConstraints(ca.cert)
  const { identity, dropped } =
    constraints === null
      ? { identity: rawIdentity, dropped: [] as readonly string[] }
      : permitsIdentity(constraints, rawIdentity)
  const leaf = await issueLeaf(ca, identity, commonName, validDays, now)
  const chainPem = `${leaf.certPem.trimEnd()}\n${ca.certPem.trimEnd()}\n`

  // Every byte exists before anything on disk is touched: a failure above
  // this line has written nothing at all.
  if (newCa) {
    if (reason === 'ca-unconstrained') archivePreviousCa(paths, ca)
    await writeFile(`${paths.caCertPath}.new`, ca.certPem, 'utf-8')
    writeOwnerOnlyFileSync(`${paths.caKeyPath}.new`, ca.keyPem)
    renameSync(`${paths.caCertPath}.new`, paths.caCertPath)
    renameSync(`${paths.caKeyPath}.new`, paths.caKeyPath)
  }

  writeOwnerOnlyFileSync(`${paths.keyPath}.new`, leaf.keyPem)
  await writeFile(`${paths.certPath}.new`, chainPem, 'utf-8')
  renameSync(`${paths.keyPath}.new`, paths.keyPath)
  renameSync(`${paths.certPath}.new`, paths.certPath)
  return dropped
}

/** The identity as far as the CA on disk may certify it; unchanged while that CA is absent or unconstrained. */
function constrainToDiskCa(
  paths: CertPaths,
  identity: CertIdentity,
): { readonly identity: CertIdentity; readonly dropped: readonly string[] } {
  try {
    const constraints = readNameConstraints(
      new PeculiarCertificate(readFileSync(paths.caCertPath, 'utf-8')),
    )
    return constraints === null ? { identity, dropped: [] } : permitsIdentity(constraints, identity)
  } catch {
    return { identity, dropped: [] }
  }
}

/**
 * One-time replacement of an UNCONSTRAINED generated CA (D873): keep the old material
 * beside the new one until the new leaf is serving (`retirePreviousLocalCa`), and write the
 * marker the admin UI reads to tell the operator that clients must re-trust the CA.
 */
function archivePreviousCa(paths: CertPaths, replacement: CaSigner): void {
  if (!existsSync(paths.caCertPath)) return
  const previousCert = `${paths.caCertPath}.previous`
  const previousKey = `${paths.caKeyPath}.previous`
  copyFileSync(paths.caCertPath, previousCert)
  if (existsSync(paths.caKeyPath)) {
    copyFileSync(paths.caKeyPath, previousKey)
  }
  const previousFingerprint = readFingerprint(paths.caCertPath)
  writeOwnerOnlyFileSync(
    join(dirname(paths.caCertPath), 'ca-replaced.json'),
    `${JSON.stringify({
      replacedAt: new Date().toISOString(),
      previousFingerprintSha256: previousFingerprint,
      fingerprintSha256: new X509Certificate(replacement.certPem).fingerprint256,
    })}\n`,
  )
}

/** Marker path for the status reader and the retire step. */
export function caReplacementMarkerFile(dataDir: string): string {
  return join(dataDir, 'tls', 'ca-replaced.json')
}

/**
 * Called once the HTTPS listener serves the leaf of the replacement CA: drop the retired
 * unconstrained CA, key first. Idempotent; returns whether anything was removed.
 */
export function retirePreviousLocalCa(dataDir: string): boolean {
  const base = join(dataDir, 'tls', 'camstack-ca')
  const files = [`${base}.key.previous`, `${base}.crt.previous`]
  const present = files.filter((file) => existsSync(file))
  for (const file of present) rmSync(file, { force: true })
  return present.length > 0
}

function describe(
  paths: CertPaths,
  generated: boolean,
  reason: CertRegenerationReason | null,
  caRotated: boolean,
  previousFingerprintSha256: string | null,
  reissueError: string | null,
  droppedNames: readonly string[],
): EnsureTlsResult {
  const leaf = new X509Certificate(readFileSync(paths.certPath))
  const ca = new X509Certificate(readFileSync(paths.caCertPath))
  const san = leaf.subjectAltName ?? ''
  return {
    ...paths,
    generated,
    reason,
    caRotated,
    fingerprintSha256: leaf.fingerprint256,
    previousFingerprintSha256,
    caFingerprintSha256: ca.fingerprint256,
    validTo: new Date(leaf.validTo).toISOString(),
    sans: san === '' ? [] : san.split(', '),
    droppedNames,
    reissueError,
  }
}

/**
 * Load TLS cert+key from files. Returns Buffers suitable for Node.js TLS
 * options. `certPath` is a full chain, so the listener presents the local
 * root alongside the leaf.
 */
export function loadTlsCert(certPath: string, keyPath: string): TlsCertPair {
  return {
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
  }
}

export type { CertIdentity, CertRegenerationReason, HostFacts }
export { collectCertIdentity, evaluateExistingCert, MAX_LEAF_VALIDITY_DAYS }
