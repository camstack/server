/**
 * The hub's record of every mesh leaf (D856): which certificate each node holds,
 * when it expires, and which serials are revoked.
 *
 * Three ways a row appears:
 *  - `enroll` / `renewal` / `boot` - the hub issued it and wrote it down at the
 *    moment of issuing (the authoritative record);
 *  - `observed` - a node enrolled before this record existed (or by a path that
 *    did not write it) presented this leaf on its LIVE mutual-TLS connection.
 *
 * Revoked serials are persisted here and replayed into the in-memory CRL at boot,
 * so a revocation survives a hub restart. Hub only: agents persist none of it.
 */
import { X509Certificate } from 'node:crypto'
import type {
  CollectionColumn,
  IScopedLogger,
  RecordKindHandle,
  SettingsStoreClient,
} from '@camstack/types'
import type { MeshNodeCertificateBody } from '../../../builtins/system-config/record-kinds.js'
import { systemConfigRecordKinds } from '../../../builtins/system-config/record-kinds.js'
import { subjectCn } from './mesh-ca.js'
import type { MeshCrl } from './mesh-crl.js'

/**
 * @durable class=config owner=system-config
 *   write="the hub records every mesh leaf it issues (enroll, renewal, boot) and every
 *     leaf a connected node is observed presenting; a revocation stamps revokedAt"
 *   retention="a revoked or expired row is kept 90 days past its end, then reaped; a
 *     live row is never deleted. Forgetting a node does not delete its rows."
 */
export const MESH_NODE_CERTIFICATES_COLLECTION = 'mesh_node_certificates'

export const MESH_NODE_CERTIFICATES_COLUMNS: readonly CollectionColumn[] = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'nodeId', type: 'TEXT' as const, notNull: true },
  { name: 'serial', type: 'TEXT' as const, notNull: true },
  { name: 'fingerprint', type: 'TEXT' as const, notNull: true },
  { name: 'notBefore', type: 'INTEGER' as const, notNull: true },
  { name: 'notAfter', type: 'INTEGER' as const, notNull: true },
  { name: 'issuedAt', type: 'INTEGER' as const, notNull: true },
  { name: 'issuedVia', type: 'TEXT' as const, notNull: true },
  { name: 'revokedAt', type: 'INTEGER' as const },
  { name: 'revokedReason', type: 'TEXT' as const },
]

export type MeshCertificateVia = 'enroll' | 'pairing' | 'renewal' | 'boot' | 'observed'

export interface MeshCertificateRecord {
  readonly nodeId: string
  readonly serial: string
  readonly fingerprint: string
  readonly notBefore: number
  readonly notAfter: number
  readonly issuedAt: number
  readonly issuedVia: MeshCertificateVia
  readonly revokedAt: number | null
  readonly revokedReason: string | null
}

export interface MeshLeafDescription {
  readonly cn: string
  readonly serial: string
  readonly fingerprint: string
  readonly notBefore: number
  readonly notAfter: number
}

const RETENTION_MS = 90 * 86_400_000
/**
 * A leaf the hub signed for a renewal that did not complete. It must not be the node's
 * `current` leaf, but it is NOT on the CRL: the node may still hold it (the swap
 * could have landed without the hub seeing it), and cutting it off would be the
 * outage the hand-over exists to prevent. If the node is later seen presenting it, it
 * is reinstated.
 */
export const RENEWAL_ABANDONED = 'renewal-abandoned'
const VIAS: readonly MeshCertificateVia[] = ['enroll', 'pairing', 'renewal', 'boot', 'observed']

/** CN, serial, fingerprint and validity of a leaf PEM (or DER). */
export function describeMeshLeaf(cert: string | Buffer): MeshLeafDescription {
  const x509 = new X509Certificate(cert)
  return {
    cn: subjectCn(x509.subject) ?? '',
    serial: x509.serialNumber,
    fingerprint: x509.fingerprint256,
    notBefore: Date.parse(x509.validFrom),
    notAfter: Date.parse(x509.validTo),
  }
}

function normalizeSerial(serial: string): string {
  return serial.replace(/^0x/i, '').replace(/:/g, '').toLowerCase()
}

function parse(data: Record<string, unknown>): MeshCertificateRecord | null {
  const str = (k: string): string | null => {
    const v = data[k]
    return typeof v === 'string' && v.length > 0 ? v : null
  }
  const num = (k: string): number | null => {
    const v = data[k]
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  }
  const nodeId = str('nodeId')
  const serial = str('serial')
  const fingerprint = str('fingerprint')
  const notBefore = num('notBefore')
  const notAfter = num('notAfter')
  const issuedAt = num('issuedAt')
  if (
    nodeId === null ||
    serial === null ||
    fingerprint === null ||
    notBefore === null ||
    notAfter === null ||
    issuedAt === null
  ) {
    return null
  }
  return {
    nodeId,
    serial,
    fingerprint,
    notBefore,
    notAfter,
    issuedAt,
    issuedVia: VIAS.find((v) => v === data['issuedVia']) ?? 'observed',
    revokedAt: num('revokedAt'),
    revokedReason: str('revokedReason'),
  }
}

export class MeshCertificateRegistry {
  private readonly rows = new Map<string, MeshCertificateRecord>()

  constructor(
    private readonly store: SettingsStoreClient,
    private readonly deps: {
      readonly now?: () => number
      readonly logger?: IScopedLogger
      readonly meshKind?: RecordKindHandle<MeshNodeCertificateBody> | null
    } = {},
  ) {}

  private recordToBody(record: MeshCertificateRecord): MeshNodeCertificateBody {
    return {
      nodeId: record.nodeId,
      serial: record.serial,
      fingerprint: record.fingerprint,
      notBefore: record.notBefore,
      notAfter: record.notAfter,
      issuedAt: record.issuedAt,
      issuedVia: record.issuedVia,
      revokedAt: record.revokedAt,
      revokedReason: record.revokedReason,
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  async load(): Promise<void> {
    const kind = this.deps.meshKind ?? null
    if (kind !== null) {
      const page = await kind.query({ limit: 10_000 })
      for (const row of page.records) {
        const { fingerprint: _fp, ...body } = row.data
        const record = parse({ ...body, fingerprint: row.id })
        if (record !== null) this.rows.set(record.fingerprint, record)
      }
      return
    }
    const rows = await this.store.query.query({ collection: MESH_NODE_CERTIFICATES_COLLECTION })
    for (const row of rows) {
      const record = parse(row.data)
      if (record !== null) this.rows.set(record.fingerprint, record)
    }
  }

  /** Write down a leaf the hub just issued. Idempotent per fingerprint. */
  async recordIssued(
    nodeId: string,
    certPem: string,
    via: Exclude<MeshCertificateVia, 'observed'>,
  ): Promise<MeshCertificateRecord> {
    const leaf = describeMeshLeaf(certPem)
    const existing = this.rows.get(leaf.fingerprint)
    if (existing !== undefined) return existing
    const record: MeshCertificateRecord = {
      nodeId,
      serial: leaf.serial,
      fingerprint: leaf.fingerprint,
      notBefore: leaf.notBefore,
      notAfter: leaf.notAfter,
      issuedAt: this.now(),
      issuedVia: via,
      revokedAt: null,
      revokedReason: null,
    }
    await this.insert(record)
    this.deps.logger?.info('Mesh certificate recorded', {
      tags: { nodeId },
      meta: { via, serial: leaf.serial, notAfter: new Date(leaf.notAfter).toISOString() },
    })
    return record
  }

  /**
   * A node was seen presenting `leaf` on its live connection. A leaf the hub already
   * knows is left alone; an unknown one is recorded `observed` (a node enrolled
   * before this record existed).
   */
  async recordObserved(nodeId: string, leaf: MeshLeafDescription): Promise<boolean> {
    const known = this.rows.get(leaf.fingerprint)
    if (known !== undefined) {
      if (known.revokedReason !== RENEWAL_ABANDONED) {
        // The node presents a leaf that is live (or revoked: nothing to converge). A live renewal
        // leaf NEWER than the one it presents is a renewal that did not take - the node reverted
        // to its previous leaf (its own rollback) - so the newer one is set aside AT ONCE and the
        // presented one is the only current leaf again. Waiting for the next inventory read left
        // the registry showing the renewal leaf as current while the node presented the old one.
        return known.revokedAt === null ? this.abandonRenewalsNewerThan(known) : false
      }
      // The node IS using the leaf we set aside: it is current again.
      const reinstated: MeshCertificateRecord = { ...known, revokedAt: null, revokedReason: null }
      this.rows.set(known.fingerprint, reinstated)
      await this.persist(reinstated)
      this.deps.logger?.warn('An abandoned renewal leaf is in use - reinstated', {
        tags: { nodeId },
        meta: { serial: known.serial },
      })
      return true
    }
    const record: MeshCertificateRecord = {
      nodeId,
      serial: leaf.serial,
      fingerprint: leaf.fingerprint,
      notBefore: leaf.notBefore,
      notAfter: leaf.notAfter,
      issuedAt: this.now(),
      issuedVia: 'observed',
      revokedAt: null,
      revokedReason: null,
    }
    await this.insert(record)
    this.deps.logger?.info('Mesh certificate observed on a live connection and recorded', {
      tags: { nodeId },
      meta: { serial: leaf.serial, fingerprint: leaf.fingerprint },
    })
    return true
  }

  list(nodeId?: string): readonly MeshCertificateRecord[] {
    return [...this.rows.values()]
      .filter((r) => nodeId === undefined || r.nodeId === nodeId)
      .toSorted((a, b) => b.issuedAt - a.issuedAt)
  }

  /** The newest non-revoked leaf of a node, or `undefined`. */
  currentFor(nodeId: string): MeshCertificateRecord | undefined {
    return this.list(nodeId).find((r) => r.revokedAt === null)
  }

  /** Every non-revoked leaf of a node (a renewal in flight has two). */
  liveFor(nodeId: string): readonly MeshCertificateRecord[] {
    return this.list(nodeId).filter((r) => r.revokedAt === null)
  }

  /** Stamp a leaf revoked (and mirror it into `crl`). `false` when unknown or already revoked. */
  async revoke(fingerprint: string, reason: string, crl?: MeshCrl): Promise<boolean> {
    const record = this.rows.get(fingerprint)
    if (record === undefined || record.revokedAt !== null) return false
    const revoked: MeshCertificateRecord = {
      ...record,
      revokedAt: this.now(),
      revokedReason: reason,
    }
    this.rows.set(fingerprint, revoked)
    crl?.revoke(record.serial)
    await this.persist(revoked)
    this.deps.logger?.warn('Mesh certificate revoked', {
      tags: { nodeId: record.nodeId },
      meta: { serial: record.serial, reason },
    })
    return true
  }

  /**
   * Operator revocation of a whole node: EVERY leaf of the node that is not already on the
   * CRL goes on it - the current one, an observed one, a renewal one, and a leaf that was set
   * aside (`renewal-abandoned`: a copy of it may sit on a stolen box, and it must not stay
   * valid just because the hub once set it aside). Returns the serials put on the CRL.
   * A leaf revoked this way is never reinstated by `recordObserved`.
   */
  async revokeAllForNode(
    nodeId: string,
    reason: string,
    crl: MeshCrl,
    /** A leaf (by fingerprint) that stays valid: the one a pairing just installed (D857). */
    keepFingerprint?: string,
  ): Promise<readonly string[]> {
    const serials: string[] = []
    for (const record of this.list(nodeId)) {
      if (keepFingerprint !== undefined && record.fingerprint === keepFingerprint) continue
      const onCrl = record.revokedAt !== null && record.revokedReason !== RENEWAL_ABANDONED
      if (onCrl) continue
      const revoked: MeshCertificateRecord = {
        ...record,
        revokedAt: record.revokedAt ?? this.now(),
        revokedReason: reason,
      }
      this.rows.set(record.fingerprint, revoked)
      crl.revoke(record.serial)
      await this.persist(revoked)
      serials.push(record.serial)
    }
    if (serials.length > 0) {
      this.deps.logger?.warn('Every mesh certificate of the node revoked', {
        tags: { nodeId },
        meta: { serials, reason },
      })
    }
    return serials
  }

  /**
   * At boot: a node with TWO live leaves had a renewal in flight when the hub stopped. The
   * newer (renewal) one is set aside - it is not the node's current leaf until the node is
   * seen presenting it, which reinstates it. It is NOT put on the CRL.
   */
  async settleInterruptedRenewals(): Promise<number> {
    let settled = 0
    const byNode = new Map<string, MeshCertificateRecord[]>()
    for (const record of this.rows.values()) {
      if (record.revokedAt !== null) continue
      byNode.set(record.nodeId, [...(byNode.get(record.nodeId) ?? []), record])
    }
    for (const records of byNode.values()) {
      if (records.length < 2) continue
      for (const record of records) {
        if (record.issuedVia === 'renewal' && (await this.abandon(record.fingerprint))) settled += 1
      }
    }
    return settled
  }

  /** Set a never-completed renewal leaf aside (not current, NOT on the CRL). */
  /** Fingerprints of renewal leaves whose handover is running right now (this process only). */
  private readonly renewalsInFlight = new Set<string>()

  /**
   * A renewal's leaf is "in flight" from signing until the handover ends. While it is, a node seen
   * presenting its OLD leaf is simply not swapped yet: the new leaf is not set aside (that would
   * flap set-aside / reinstate on the node's first connection with it).
   */
  beginRenewal(fingerprint: string): void {
    this.renewalsInFlight.add(fingerprint)
  }

  endRenewal(fingerprint: string): void {
    this.renewalsInFlight.delete(fingerprint)
  }

  private async abandonRenewalsNewerThan(presented: MeshCertificateRecord): Promise<boolean> {
    let changed = false
    for (const record of this.liveFor(presented.nodeId)) {
      if (record.fingerprint === presented.fingerprint) continue
      if (record.issuedVia !== 'renewal' || record.issuedAt <= presented.issuedAt) continue
      if (this.renewalsInFlight.has(record.fingerprint)) continue
      if (await this.abandon(record.fingerprint)) changed = true
    }
    return changed
  }

  async abandon(fingerprint: string): Promise<boolean> {
    const record = this.rows.get(fingerprint)
    if (record === undefined || record.revokedAt !== null) return false
    const abandoned: MeshCertificateRecord = {
      ...record,
      revokedAt: this.now(),
      revokedReason: RENEWAL_ABANDONED,
    }
    this.rows.set(fingerprint, abandoned)
    await this.persist(abandoned)
    this.deps.logger?.warn('Renewal leaf set aside (not current, not on the CRL)', {
      tags: { nodeId: record.nodeId },
      meta: { serial: record.serial },
    })
    return true
  }

  /** Replay every persisted revocation into `crl` (hub boot). Set-aside leaves are not revocations. */
  restoreCrl(crl: MeshCrl): number {
    let restored = 0
    for (const record of this.rows.values()) {
      if (record.revokedAt === null || record.revokedReason === RENEWAL_ABANDONED) continue
      crl.revoke(record.serial)
      restored += 1
    }
    return restored
  }

  /** Is `serial` listed as revoked here? */
  isRevoked(serial: string): boolean {
    const wanted = normalizeSerial(serial)
    for (const record of this.rows.values()) {
      if (
        record.revokedAt !== null &&
        record.revokedReason !== RENEWAL_ABANDONED &&
        normalizeSerial(record.serial) === wanted
      ) {
        return true
      }
    }
    return false
  }

  async reap(): Promise<number> {
    const cutoff = this.now() - RETENTION_MS
    const dead = [...this.rows.values()].filter((r) => (r.revokedAt ?? r.notAfter) < cutoff)
    for (const r of dead) {
      this.rows.delete(r.fingerprint)
      await this.deleteRow(r.fingerprint)
    }
    return dead.length
  }

  private async insert(record: MeshCertificateRecord): Promise<void> {
    this.rows.set(record.fingerprint, record)
    const kind = this.deps.meshKind ?? null
    if (kind !== null) {
      const parsed = systemConfigRecordKinds['mesh-node-certificates'].schema.safeParse(
        this.recordToBody(record),
      )
      if (!parsed.success) throw new Error(parsed.error.message)
      await kind.put({ id: record.fingerprint, data: parsed.data })
      return
    }
    await this.store.insert.mutate({
      collection: MESH_NODE_CERTIFICATES_COLLECTION,
      record: { id: record.fingerprint, data: { ...record } },
    })
  }

  private async deleteRow(fingerprint: string): Promise<void> {
    const kind = this.deps.meshKind ?? null
    if (kind !== null) {
      await kind.delete(fingerprint)
      return
    }
    await this.store.delete.mutate({
      collection: MESH_NODE_CERTIFICATES_COLLECTION,
      key: fingerprint,
    })
  }

  private async persist(record: MeshCertificateRecord): Promise<void> {
    try {
      const kind = this.deps.meshKind ?? null
      if (kind !== null) {
        const parsed = systemConfigRecordKinds['mesh-node-certificates'].schema.safeParse(
          this.recordToBody(record),
        )
        if (!parsed.success) throw new Error(parsed.error.message)
        await kind.put({ id: record.fingerprint, data: parsed.data })
        return
      }
      await this.store.update.mutate({
        collection: MESH_NODE_CERTIFICATES_COLLECTION,
        id: record.fingerprint,
        data: { ...record },
      })
    } catch (error: unknown) {
      this.deps.logger?.error('Mesh certificate write failed - the change holds until restart', {
        tags: { nodeId: record.nodeId },
        meta: { error: error instanceof Error ? error.message : String(error) },
      })
    }
  }
}

const SLOT = Symbol.for('camstack.mesh.certificate-registry')

export function setProcessMeshCertificateRegistry(registry: MeshCertificateRegistry | null): void {
  if (registry === null) Reflect.deleteProperty(globalThis, SLOT)
  else Reflect.set(globalThis, SLOT, registry)
}

export function getProcessMeshCertificateRegistry(): MeshCertificateRegistry | null {
  const value: unknown = Reflect.get(globalThis, SLOT)
  // Duck-typed: a bundled copy of this module is not the same class.
  return value !== null &&
    typeof value === 'object' &&
    typeof Reflect.get(value, 'recordIssued') === 'function'
    ? (value as MeshCertificateRegistry)
    : null
}
