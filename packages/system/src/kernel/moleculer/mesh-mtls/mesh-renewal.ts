/**
 * Mesh leaf renewal and revocation, driven by the hub (D856).
 *
 * The rule that shapes the order: a node must never be left without a leaf that
 * works. So renewal is a handover, not a replacement:
 *
 *   1. the node makes a NEW key pair and a CSR (the key never leaves it);
 *   2. the hub signs it (CN = the node id) and RECORDS the new leaf;
 *   3. the node persists it beside the old one and reconnects with it;
 *   4. the hub waits until it SEES that node connected presenting the NEW leaf;
 *   5. only then does the hub tell the node to keep it, and put the OLD serial on
 *      the CRL.
 *
 * Failure at any step before 5 leaves the old leaf valid and not revoked, asks the
 * node to go back to it (the node also goes back by itself when no confirmation
 * arrives in time), and returns the reason. The new serial is never revoked on
 * failure: the node may still hold it, and cutting it off would be the very
 * outage this order exists to prevent.
 *
 * Every step is logged with the node id.
 */
import type { MeshCaSigner } from './mesh-ca.js'
import { issueMeshLeafFromCsr } from './mesh-ca.js'
import { describeMeshLeaf, type MeshCertificateRegistry } from './mesh-certificate-registry.js'
import type { MeshCrl } from './mesh-crl.js'
import type { MeshPeerLeaf } from './mesh-peer-transport.js'

/** The node side, as the hub calls it (the `node-certificates` capability, pinned to the node). */
export interface NodeMeshClient {
  prepareMeshRenewal(): Promise<{ readonly csrPem: string }>
  installMeshLeaf(input: {
    readonly certPem: string
    readonly caCertPem: string
    readonly confirmWithinMs: number
  }): Promise<{ readonly fingerprintSha256: string; readonly serial: string }>
  confirmMeshLeaf(input: {
    readonly fingerprintSha256: string
  }): Promise<{ readonly confirmed: boolean }>
  rollbackMeshLeaf(): Promise<{ readonly rolledBack: boolean }>
}

export interface MeshPeers {
  /** The leaf `nodeId` presented at its last handshake, while connected. */
  peerLeaf(nodeId: string): MeshPeerLeaf | undefined
  /** Close the node's mutual-TLS sockets. */
  dropPeer(nodeId: string): number
}

/** "Node X finished registering" - the hub's registration completion (D3), not a poll. */
export interface MeshRegistrations {
  subscribe(listener: (nodeId: string, addonIds?: readonly string[]) => void): () => void
}

export interface MeshLog {
  info(
    message: string,
    extras?: { tags?: Record<string, string>; meta?: Record<string, unknown> },
  ): void
  warn(
    message: string,
    extras?: { tags?: Record<string, string>; meta?: Record<string, unknown> },
  ): void
  error(
    message: string,
    extras?: { tags?: Record<string, string>; meta?: Record<string, unknown> },
  ): void
}

export interface RenewMeshDeps {
  readonly nodeId: string
  readonly client: NodeMeshClient
  readonly ca: MeshCaSigner
  readonly registry: MeshCertificateRegistry
  readonly crl: MeshCrl
  readonly peers: MeshPeers
  /** Registration completions: the node is usable once its manifest has landed. */
  readonly registrations: MeshRegistrations
  readonly log: MeshLog
  /**
   * The addon ids the hub holds for the node BEFORE the renewal (its own and its children's). The
   * node is "back" only on a registration that carries all of them again: a registration that has
   * lost its forked children is a node that is online and capless, not a node that came back.
   * Absent: any registration with the new leaf counts.
   */
  readonly expectedAddons?: (nodeId: string) => readonly string[]
  /** How long to wait for the node to be back AND registered with the new leaf. */
  readonly reconnectTimeoutMs?: number
  /** Gap between attempts to confirm while the node's capability is not there yet. */
  readonly confirmRetryMs?: number
  readonly sleep?: (ms: number) => Promise<void>
  /** Single deadline timer (not a scan); a seam for specs. */
  readonly setTimer?: (fn: () => void, ms: number) => { cancel(): void }
  readonly now?: () => number
}

export type RenewMeshResult =
  | {
      readonly ok: true
      readonly oldSerial: string | null
      readonly newSerial: string
      readonly newNotAfter: number
    }
  | {
      readonly ok: false
      readonly stage: 'prepare' | 'issue' | 'install' | 'reconnect' | 'confirm'
      readonly reason: string
      /** The node is back on its previous leaf (or never left it). */
      readonly keptPreviousLeaf: boolean
    }

const DEFAULT_RECONNECT_TIMEOUT_MS = 45_000
const DEFAULT_CONFIRM_RETRY_MS = 500

function defaultSetTimer(fn: () => void, ms: number): { cancel(): void } {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function renewMeshCertificate(deps: RenewMeshDeps): Promise<RenewMeshResult> {
  const inFlight: { fingerprint: string | null } = { fingerprint: null }
  try {
    return await runRenewal(deps, inFlight)
  } finally {
    if (inFlight.fingerprint !== null) {
      deps.registry.endRenewal(inFlight.fingerprint)
      // The handover is over: converge on whatever the node presents NOW (a node that reverted
      // while the confirm was still retrying keeps the renewal leaf current until this).
      const live = deps.peers.peerLeaf(deps.nodeId)
      if (live !== undefined) {
        await deps.registry
          .recordObserved(deps.nodeId, {
            cn: deps.nodeId,
            serial: live.serial,
            fingerprint: live.fingerprint,
            notBefore: live.notBefore,
            notAfter: live.notAfter,
          })
          .catch(() => undefined)
      }
    }
  }
}

async function runRenewal(
  deps: RenewMeshDeps,
  inFlight: { fingerprint: string | null },
): Promise<RenewMeshResult> {
  const { nodeId, log } = deps
  const tags = { nodeId }
  const sleep = deps.sleep ?? defaultSleep
  const confirmRetryMs = deps.confirmRetryMs ?? DEFAULT_CONFIRM_RETRY_MS
  const setTimer = deps.setTimer ?? defaultSetTimer
  const timeoutMs = deps.reconnectTimeoutMs ?? DEFAULT_RECONNECT_TIMEOUT_MS
  const now = deps.now ?? Date.now

  // The leaf the node holds NOW: what it presents, else what the registry says.
  const live = deps.peers.peerLeaf(nodeId)
  const previous = live ?? deps.registry.currentFor(nodeId)
  if (live !== undefined) {
    await deps.registry.recordObserved(nodeId, {
      cn: nodeId,
      serial: live.serial,
      fingerprint: live.fingerprint,
      notBefore: live.notBefore,
      notAfter: live.notAfter,
    })
  }
  log.info('Mesh renewal: starting', {
    tags,
    meta: {
      currentSerial: previous?.serial ?? null,
      connected: live !== undefined,
    },
  })

  const fail = (
    stage: 'prepare' | 'issue' | 'install' | 'reconnect' | 'confirm',
    reason: string,
    keptPreviousLeaf: boolean,
  ): RenewMeshResult => {
    log.error('Mesh renewal: failed', {
      tags,
      meta: { stage, reason, keptPreviousLeaf },
    })
    return { ok: false, stage, reason, keptPreviousLeaf }
  }

  let csrPem: string
  try {
    csrPem = (await deps.client.prepareMeshRenewal()).csrPem
    log.info('Mesh renewal: the node generated a new key and sent its CSR', {
      tags,
    })
  } catch (error: unknown) {
    return fail('prepare', message(error), true)
  }

  let issued: { certPem: string; serialNumber: string; notAfter: Date }
  try {
    issued = await issueMeshLeafFromCsr(deps.ca, csrPem, {
      expectedNodeId: nodeId,
    })
    await deps.registry.recordIssued(nodeId, issued.certPem, 'renewal')
    log.info('Mesh renewal: new leaf signed and recorded', {
      tags,
      meta: {
        serial: issued.serialNumber,
        notAfter: issued.notAfter.toISOString(),
      },
    })
  } catch (error: unknown) {
    return fail('issue', message(error), true)
  }
  const newLeaf = describeMeshLeaf(issued.certPem)
  deps.registry.beginRenewal(newLeaf.fingerprint)
  inFlight.fingerprint = newLeaf.fingerprint

  // Subscribe BEFORE the install: the node reconnects the moment it has the leaf.
  let resolveRegistered: (ok: boolean) => void = () => undefined
  const registeredPromise = new Promise<boolean>((resolve) => {
    resolveRegistered = resolve
  })
  const expected = deps.expectedAddons?.(nodeId) ?? []
  let missingAddons: readonly string[] = []
  const unsubscribe = deps.registrations.subscribe((id, addonIds) => {
    if (id !== nodeId || deps.peers.peerLeaf(nodeId)?.fingerprint !== newLeaf.fingerprint) return
    if (addonIds !== undefined) {
      const present = new Set(addonIds)
      missingAddons = expected.filter((addonId) => !present.has(addonId))
      if (missingAddons.length > 0) {
        log.warn('Mesh renewal: the node registered without addons it had before - waiting', {
          tags,
          meta: { missing: missingAddons },
        })
        return
      }
    }
    resolveRegistered(true)
  })
  const deadlineTimer = setTimer(() => resolveRegistered(false), timeoutMs)
  void registeredPromise.then(() => deadlineTimer.cancel())

  try {
    await deps.client.installMeshLeaf({
      certPem: issued.certPem,
      caCertPem: deps.ca.certPem,
      confirmWithinMs: timeoutMs + 30_000,
    })
    log.info('Mesh renewal: the node installed the new leaf and is reconnecting', { tags })
  } catch (error: unknown) {
    // The node may be mid-swap; ask it to go back, best effort.
    unsubscribe()
    deadlineTimer.cancel()
    await deps.client.rollbackMeshLeaf().catch(() => undefined)
    // It may still hold the leaf: set it aside (not current, not on the CRL).
    await deps.registry.abandon(newLeaf.fingerprint)
    return fail('install', message(error), true)
  }

  // The handshake only says WHO connected. The node is usable when its registerNode has
  // landed presenting the new leaf, and only then may the old leaf be retired: confirming
  // on the handshake would race the node's capabilities. Waiting is an event (the hub's
  // registration completion), with one deadline timer - never a scan.
  const deadline = now() + timeoutMs
  const registered = await registeredPromise
  unsubscribe()
  if (!registered) {
    const back = await deps.client.rollbackMeshLeaf().catch(() => ({ rolledBack: false }))
    log.warn('Mesh renewal: the node was not back and registered with the new leaf in time', {
      tags,
      meta: { timeoutMs, rolledBack: back.rolledBack },
    })
    await deps.registry.abandon(newLeaf.fingerprint)
    const lost =
      missingAddons.length > 0
        ? ` (its last registration lacked ${missingAddons.length} addon(s) it had before: ${missingAddons.slice(0, 5).join(', ')}; ` +
          'the swap was rolled back and nothing was revoked - once those addons are running again the next renewal will go through)'
        : ''
    return fail(
      'reconnect',
      `the node was not back and registered with the new leaf within ${Math.round(timeoutMs / 1000)} s${lost}; ` +
        'the previous leaf was kept and is still valid',
      true,
    )
  }
  log.info('Mesh renewal: the node registered presenting the new leaf', {
    tags,
  })

  // The provider may not be routable for an instant after registering: retry to the deadline.
  let confirmError = 'the node did not confirm the new leaf'
  let confirmedByNode = false
  for (;;) {
    try {
      const confirmed = await deps.client.confirmMeshLeaf({
        fingerprintSha256: newLeaf.fingerprint,
      })
      if (confirmed.confirmed) {
        confirmedByNode = true
        break
      }
      confirmError = 'the node did not confirm the new leaf'
    } catch (error: unknown) {
      confirmError = message(error)
      log.warn('Mesh renewal: confirm not accepted yet', {
        tags,
        meta: { error: confirmError },
      })
    }
    if (now() >= deadline) break
    await sleep(confirmRetryMs)
  }
  if (!confirmedByNode) {
    // The node is on the new leaf; its own timer may revert it. The old serial is NOT
    // revoked, so either outcome leaves a working leaf.
    return fail('confirm', confirmError, false)
  }

  // Only now is the old leaf retired.
  if (previous !== undefined && previous.serial !== newLeaf.serial) {
    // The registry row when it has one; the CRL entry regardless.
    await deps.registry.revoke(previous.fingerprint, 'replaced-by-renewal', deps.crl)
    deps.crl.revoke(previous.serial)
    log.info('Mesh renewal: the previous leaf is revoked', {
      tags,
      meta: { oldSerial: previous.serial },
    })
  }
  log.info('Mesh renewal: done', {
    tags,
    meta: {
      newSerial: newLeaf.serial,
      notAfter: new Date(newLeaf.notAfter).toISOString(),
    },
  })
  return {
    ok: true,
    oldSerial: previous?.serial ?? null,
    newSerial: newLeaf.serial,
    newNotAfter: newLeaf.notAfter,
  }
}

export interface RevokeMeshResult {
  readonly nodeId: string
  /** Serials now on the revocation list for this node. */
  readonly revokedSerials: readonly string[]
  /** Live sockets that were closed. */
  readonly disconnected: number
  /** What the operator does next - revoking never forgets the node. */
  readonly next: string
}

/**
 * Revoke every live mesh leaf of `nodeId` and cut its connection. The node cannot
 * reconnect: it must be paired again. The node is NOT forgotten
 * (that stays `clusterNodes.forgetNode`).
 */
export async function revokeMeshCertificate(deps: {
  readonly nodeId: string
  readonly registry: MeshCertificateRegistry
  readonly crl: MeshCrl
  readonly peers: MeshPeers
  readonly log: MeshLog
  /** Recorded on every certificate revoked (default `revoked-by-operator`). */
  readonly reason?: string
}): Promise<RevokeMeshResult> {
  const { nodeId, log } = deps
  const tags = { nodeId }
  // A node never recorded is recorded from its live leaf first, so the revoke has a serial.
  const live = deps.peers.peerLeaf(nodeId)
  if (live !== undefined) {
    await deps.registry.recordObserved(nodeId, {
      cn: nodeId,
      serial: live.serial,
      fingerprint: live.fingerprint,
      notBefore: live.notBefore,
      notAfter: live.notAfter,
    })
  }
  // EVERY leaf of the node - live, observed, renewal and set-aside - goes on the CRL.
  const serials = [
    ...(await deps.registry.revokeAllForNode(
      nodeId,
      deps.reason ?? 'revoked-by-operator',
      deps.crl,
    )),
  ]
  const disconnected = deps.peers.dropPeer(nodeId)
  log.warn('Mesh certificate revoked and the node disconnected', {
    tags,
    meta: { serials, disconnected },
  })
  return {
    nodeId,
    revokedSerials: serials,
    disconnected,
    next: 'The node can no longer connect. Pair it again from the hub (System -> Cluster -> Agents); to remove it from the cluster use Forget node.',
  }
}
