/**
 * The agent's side of certificate management (D856): the `node-certificates`
 * capability, provided by the agent runtime and called by the hub through the
 * ordinary node-pinned capability call.
 *
 * MESH leaf. The hub asks for a CSR; this node makes a NEW key pair (the key never
 * leaves it) and keeps it in memory only. When the signed leaf arrives it is persisted
 * into `agent.json` (0600) BESIDE the old one (`meshTlsPrevious`) together with the
 * swap's state (`meshSwap`: which leaf, until when), then the agent reconnects through
 * the same `reconnect()` the UI uses, which replaces the broker transport from the file
 * (the broker, its services and its child runners stay).
 *
 * A swap is PENDING from install until the hub confirms. Only while it is pending may
 * the node go back, and only to a previous leaf that is still unexpired:
 *  - the swap state is in the file, not in memory, so it survives a restart: at boot a
 *    swap whose deadline is still ahead re-arms its rollback timer; one whose deadline
 *    has passed is settled (the current leaf stays, the leftovers are dropped);
 *  - a `meshTlsPrevious` with no pending swap is a leftover and is deleted at boot and on
 *    the next renewal, so a failed renewal can never restore a stale or expired leaf.
 *
 * HTTPS leaf. Same shape: key pair + CSR here, signed public key back, ONE atomic file
 * under `<dataDir>/tls`, hot-swapped into the sniffing listener.
 */
import { createPrivateKey, X509Certificate } from 'node:crypto'
import type { INodeCertificatesProvider } from '@camstack/types'
import {
  collectAgentNames,
  createAgentHttpsRequest,
  createMeshCsrPem,
  describeHttpsLeaf,
  describeMeshLeaf,
  exportMeshPrivateKeyPem,
  generateMeshKeyPair,
  type HostFacts,
  installAgentHttps,
  loadAgentHttps,
  pinnedHttpsCaFingerprint,
} from '@camstack/system'
import { readJsonFile, writeJsonFile0600 } from './agent-json-file.js'
import type { SniffingListener } from './agent-sniffing-listener.js'

export interface NodeCertificatesLog {
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

export interface AgentNodeCertificatesDeps {
  readonly nodeId: string
  readonly dataDir: string
  /** `agent.json`. */
  readonly configPath: string
  /** Replace the broker transport from `agent.json`, in place (the UI reconnect path). Serialized by the caller. */
  readonly reconnect: () => Promise<void>
  /** Unpair this agent (D857). Schedules the erase and returns at once; the hub's call is answered first. */
  readonly forgetHub: () => void
  readonly getHttpsListener: () => SniffingListener | null
  readonly hostFacts: HostFacts
  readonly log: NodeCertificatesLog
  readonly now?: () => number
  /** Timer seam for specs. */
  readonly schedule?: (fn: () => void, ms: number) => { cancel(): void }
}

/** Let the capability answer before the broker is torn down and rebuilt. */
const RECONNECT_DELAY_MS = 400
/** A swap found pending at boot gets at least this long for the hub to confirm. */
const MIN_REARM_MS = 10_000

interface MeshMaterial {
  readonly certPem: string
  readonly keyPem: string
  readonly caCertPem: string
}

interface MeshSwap {
  readonly fingerprint: string
  readonly deadline: number
}

function isMeshMaterial(value: unknown): value is MeshMaterial {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof Reflect.get(value, 'certPem') === 'string' &&
    typeof Reflect.get(value, 'keyPem') === 'string' &&
    typeof Reflect.get(value, 'caCertPem') === 'string'
  )
}

function isMeshSwap(value: unknown): value is MeshSwap {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof Reflect.get(value, 'fingerprint') === 'string' &&
    typeof Reflect.get(value, 'deadline') === 'number'
  )
}

function defaultSchedule(fn: () => void, ms: number): { cancel(): void } {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

export function createAgentNodeCertificates(
  deps: AgentNodeCertificatesDeps,
): INodeCertificatesProvider {
  const { nodeId, log } = deps
  const tags = { nodeId }
  const schedule = deps.schedule ?? defaultSchedule
  const now = deps.now ?? Date.now
  let pendingKeyPem: string | null = null
  let rollbackTimer: { cancel(): void } | null = null

  const readMesh = (): {
    current: MeshMaterial | null
    previous: MeshMaterial | null
    swap: MeshSwap | null
  } => {
    const raw = readJsonFile(deps.configPath)
    return {
      current: isMeshMaterial(raw['meshTls']) ? raw['meshTls'] : null,
      previous: isMeshMaterial(raw['meshTlsPrevious']) ? raw['meshTlsPrevious'] : null,
      swap: isMeshSwap(raw['meshSwap']) ? raw['meshSwap'] : null,
    }
  }

  const stillValid = (material: MeshMaterial): boolean => {
    try {
      return describeMeshLeaf(material.certPem).notAfter > now()
    } catch {
      return false
    }
  }

  /** Write `agent.json` with the swap leftovers removed and `meshTls` optionally replaced. */
  const writeSettled = (replaceCurrent?: MeshMaterial): void => {
    const raw = readJsonFile(deps.configPath)
    const { meshTlsPrevious: _p, meshSwap: _s, ...rest } = raw
    writeJsonFile0600(deps.configPath, {
      ...rest,
      ...(replaceCurrent !== undefined ? { meshTls: replaceCurrent } : {}),
    })
  }

  const reconnectSoon = (): void => {
    schedule(() => {
      deps.reconnect().catch((error: unknown) => {
        log.error('Mesh leaf swap: reconnect failed', {
          tags,
          meta: { error: error instanceof Error ? error.message : String(error) },
        })
      })
    }, RECONNECT_DELAY_MS)
  }

  /**
   * Go back to the previous leaf. Only while a swap is PENDING and only to a leaf that is
   * still unexpired; otherwise the file is settled as it is and `false` is returned.
   */
  const revert = (why: string): boolean => {
    const { current, previous, swap } = readMesh()
    rollbackTimer?.cancel()
    rollbackTimer = null
    if (swap === null) {
      log.warn('Mesh leaf rollback refused: no swap is pending', { tags, meta: { why } })
      if (previous !== null) writeSettled() // a leftover; never a rollback target
      return false
    }
    if (previous === null || !stillValid(previous)) {
      log.warn(
        'Mesh leaf rollback refused: the previous leaf is gone or expired - keeping the current one',
        {
          tags,
          meta: { why, currentValid: current !== null && stillValid(current) },
        },
      )
      writeSettled()
      return false
    }
    writeSettled(previous)
    log.warn('Mesh leaf swap: reverted to the previous leaf', { tags, meta: { why } })
    reconnectSoon()
    return true
  }

  const armRollback = (ms: number): void => {
    rollbackTimer?.cancel()
    rollbackTimer = schedule(() => {
      revert('the hub did not confirm the new leaf in time')
    }, ms)
  }

  // Boot: decide which leaf is current and drop whatever a past swap left behind.
  const settleAtBoot = (): void => {
    const { current, previous, swap } = readMesh()
    if (previous === null && swap === null) return
    if (swap !== null && previous !== null && swap.deadline > now()) {
      armRollback(Math.max(MIN_REARM_MS, swap.deadline - now()))
      log.warn('Mesh leaf swap was pending at boot - waiting for the hub to confirm', {
        tags,
        meta: { remainingMs: swap.deadline - now() },
      })
      return
    }
    if (current !== null && stillValid(current)) {
      writeSettled()
      log.info('Mesh leaf swap leftovers removed at boot (the current leaf is valid)', { tags })
      return
    }
    if (previous !== null && stillValid(previous)) {
      writeSettled(previous)
      log.warn('The current mesh leaf is expired and the previous one is valid - restored it', {
        tags,
      })
      reconnectSoon()
      return
    }
    writeSettled()
    log.error('No valid mesh leaf on this node: renew it from the hub or pair it again', {
      tags,
    })
  }
  settleAtBoot()

  return {
    getCertificates: async () => {
      const { current } = readMesh()
      const https = loadAgentHttps(deps.dataDir, (reason) =>
        log.error('The HTTPS bundle on disk is unusable - serving plain HTTP only', {
          tags,
          meta: { reason },
        }),
      )
      let mesh = null
      if (current !== null) {
        const leaf = describeMeshLeaf(current.certPem)
        mesh = {
          cn: leaf.cn,
          serial: leaf.serial,
          fingerprintSha256: leaf.fingerprint,
          notBefore: leaf.notBefore,
          notAfter: leaf.notAfter,
        }
      }
      return {
        nodeId,
        mesh,
        https:
          https === null
            ? {
                state: 'not-issued' as const,
                reason: 'No hub-issued HTTPS certificate has been installed on this node yet.',
              }
            : { state: 'served' as const, leaf: describeHttpsLeaf(https.certPem) },
      }
    },

    prepareMeshRenewal: async () => {
      const { current, swap } = readMesh()
      if (current === null) {
        throw new Error('this node is not enrolled on mesh mTLS - there is no leaf to renew')
      }
      if (swap !== null && swap.deadline > now()) {
        throw new Error('a mesh leaf swap is already pending on this node')
      }
      // A leftover from a finished or failed swap is never a rollback target.
      writeSettled()
      const keys = await generateMeshKeyPair()
      pendingKeyPem = await exportMeshPrivateKeyPem(keys.privateKey)
      const csrPem = await createMeshCsrPem(keys, nodeId)
      log.info('Mesh leaf renewal: new key and CSR generated', { tags })
      return { csrPem }
    },

    installMeshLeaf: async (input) => {
      const { current } = readMesh()
      if (current === null) throw new Error('this node is not enrolled on mesh mTLS')
      if (pendingKeyPem === null) {
        throw new Error('no pending key: prepareMeshRenewal was not called (or the node restarted)')
      }
      const leaf = new X509Certificate(input.certPem)
      const ca = new X509Certificate(input.caCertPem)
      const currentCa = new X509Certificate(current.caCertPem)
      if (ca.fingerprint256 !== currentCa.fingerprint256) {
        throw new Error('the CA that came with the new leaf is not the CA this node trusts')
      }
      if (!leaf.verify(ca.publicKey)) throw new Error('the new leaf is not signed by that CA')
      if (
        !new RegExp(`(?:^|\\n)CN=${nodeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\n|$)`).test(
          leaf.subject,
        )
      ) {
        throw new Error(`the new leaf is not issued for "${nodeId}"`)
      }
      if (!leaf.checkPrivateKey(createPrivateKey(pendingKeyPem))) {
        throw new Error('the new leaf does not match the key this node generated')
      }
      const raw = readJsonFile(deps.configPath)
      const swap: MeshSwap = {
        fingerprint: leaf.fingerprint256,
        deadline: now() + input.confirmWithinMs,
      }
      writeJsonFile0600(deps.configPath, {
        ...raw,
        meshTls: { certPem: input.certPem, keyPem: pendingKeyPem, caCertPem: current.caCertPem },
        meshTlsPrevious: current,
        meshSwap: swap,
      })
      pendingKeyPem = null
      armRollback(input.confirmWithinMs)
      log.info('Mesh leaf swap: new leaf persisted, reconnecting', {
        tags,
        meta: { serial: leaf.serialNumber, confirmWithinMs: input.confirmWithinMs },
      })
      reconnectSoon()
      return { fingerprintSha256: leaf.fingerprint256, serial: leaf.serialNumber }
    },

    confirmMeshLeaf: async (input) => {
      const { swap } = readMesh()
      if (swap === null || swap.fingerprint !== input.fingerprintSha256) {
        return { confirmed: false }
      }
      rollbackTimer?.cancel()
      rollbackTimer = null
      writeSettled()
      log.info('Mesh leaf swap: confirmed by the hub, previous leaf forgotten', { tags })
      return { confirmed: true }
    },

    rollbackMeshLeaf: async () => ({ rolledBack: revert('the hub asked for a rollback') }),

    forgetHub: async () => {
      log.warn('The hub unpaired this agent', { tags })
      deps.forgetHub()
      return { ok: true as const }
    },

    prepareHttpsCertificate: async () => {
      const names = collectAgentNames(nodeId, deps.hostFacts)
      const request = await createAgentHttpsRequest(deps.dataDir, nodeId, names)
      log.info('HTTPS certificate: new key and CSR generated', {
        tags,
        meta: { hostnames: names.hostnames.length, addresses: names.addresses.length },
      })
      return {
        csrPem: request.csrPem,
        hostnames: [...names.hostnames],
        addresses: [...names.addresses],
        pinnedCaFingerprintSha256: pinnedHttpsCaFingerprint(deps.dataDir),
      }
    },

    installHttpsCertificate: async (input) => {
      const material = installAgentHttps(deps.dataDir, input)
      const listener = deps.getHttpsListener()
      if (listener === null) {
        log.warn('HTTPS certificate installed on disk but the agent HTTP listener is not up', {
          tags,
        })
      } else if (!listener.setMaterial({ keyPem: material.keyPem, certPem: material.certPem })) {
        log.error(
          'The new HTTPS certificate was installed but the listener refused it - the previous one keeps serving',
          {
            tags,
          },
        )
      }
      const leaf = describeHttpsLeaf(material.certPem)
      log.info('HTTPS certificate installed and hot-swapped', {
        tags,
        meta: {
          fingerprint: leaf.fingerprintSha256,
          notAfter: new Date(leaf.notAfter).toISOString(),
        },
      })
      return leaf
    },
  }
}
