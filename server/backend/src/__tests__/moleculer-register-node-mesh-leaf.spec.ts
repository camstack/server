/**
 * D856 amendment (2026-10-15 incident): when an agent reverted a mesh leaf swap and registered
 * again presenting its PREVIOUS leaf, the hub's registry kept the unconfirmed renewal leaf as
 * `current` (and `presentingCurrent: false`) until somebody read the inventory. The registration
 * the node sends is the observation: it records the leaf the node presents NOW and sets aside a
 * renewal leaf it no longer presents. The same registration announces the addons it carries, so a
 * renewal can tell a node that came back whole from one that lost its forked children.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  CapabilityRegistry,
  describeMeshLeaf,
  generateMeshCa,
  issueMeshLeafForNode,
  MeshCertificateRegistry,
  onProcessNodeRegistered,
  RENEWAL_ABANDONED,
  setProcessMeshCertificateRegistry,
  setProcessMeshPeerTransportLookup,
} from '@camstack/system'
import type { RegisterNodeParams } from '@camstack/system'
import type { IScopedLogger, SettingsStoreClient, SystemEvent } from '@camstack/types'
import { MoleculerService } from '../core/moleculer/moleculer.service.js'
import type { EventBusService } from '../core/events/event-bus.service.js'
import type { ConfigService } from '../core/config/config.service.js'
import type { LoggingService } from '../core/logging/logging.service.js'
import type { CapabilityService } from '../core/capability/capability.service.js'
import type { StreamProbeService } from '../core/streaming/stream-probe.service.js'

const NODE = 'agent-a'

interface RegisterNodeDriver {
  onRegisterNode: (params: RegisterNodeParams) => void
  getNodeAddonIds: (nodeId: string) => readonly string[]
}

function makeLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function createDriver(): RegisterNodeDriver {
  const registry = new CapabilityRegistry(makeLogger())
  registry.ready()
  const service = new MoleculerService(
    {
      emit: (_event: SystemEvent) => undefined,
      subscribe: () => () => undefined,
      getRecent: () => [],
    } as unknown as EventBusService,
    {
      get: () => undefined,
      getAddonConfig: () => ({}),
    } as unknown as ConfigService,
    {
      createLogger: () => makeLogger(),
      writeFromWorker: () => undefined,
    } as unknown as LoggingService,
    { getRegistry: () => registry } as unknown as CapabilityService,
    {} as unknown as StreamProbeService,
  )
  return service as unknown as RegisterNodeDriver
}

/** A settings store that keeps nothing: the registry holds its rows in memory. */
function nullStore(): SettingsStoreClient {
  const ok = { mutate: async () => undefined }
  return {
    insert: ok,
    update: ok,
    delete: ok,
    query: { query: async () => [] },
  } as unknown as SettingsStoreClient
}

describe('MoleculerService.onRegisterNode - the registration is the observation of the node leaf', () => {
  afterEach(() => {
    setProcessMeshCertificateRegistry(null)
    setProcessMeshPeerTransportLookup(null)
  })

  it('a node that reverted to its previous leaf sets the unconfirmed renewal leaf aside, and the registration announces its addons', async () => {
    let now = 1_000
    const registry = new MeshCertificateRegistry(nullStore(), {
      now: () => now,
    })
    const ca = await generateMeshCa()
    const previous = await issueMeshLeafForNode(ca, NODE)
    await registry.recordIssued(NODE, previous.certPem, 'enroll')
    now += 60_000
    const renewal = await issueMeshLeafForNode(ca, NODE)
    await registry.recordIssued(NODE, renewal.certPem, 'renewal')
    expect(registry.currentFor(NODE)?.issuedVia).toBe('renewal')
    setProcessMeshCertificateRegistry(registry)

    // The node presents its PREVIOUS leaf on its live connection.
    const presented = describeMeshLeaf(previous.certPem)
    setProcessMeshPeerTransportLookup({
      transportOf: () => undefined,
      peerLeaf: () => ({
        serial: presented.serial,
        fingerprint: presented.fingerprint,
        notBefore: presented.notBefore,
        notAfter: presented.notAfter,
      }),
      dropPeer: () => 0,
    })
    const announced: Array<readonly string[] | undefined> = []
    const unsubscribe = onProcessNodeRegistered((id, addonIds) => {
      if (id === NODE) announced.push(addonIds)
    })

    const driver = createDriver()
    driver.onRegisterNode({
      nodeId: NODE,
      addons: [
        { addonId: 'agent-runtime', capabilities: [] },
        { addonId: 'pipeline-runner', capabilities: [] },
      ],
    })
    unsubscribe()
    // The observation is asynchronous but immediate: one macrotask turn, no scan, no timer.
    await new Promise((resolve) => setImmediate(resolve))

    expect(registry.currentFor(NODE)?.fingerprint).toBe(presented.fingerprint)
    expect(registry.list(NODE).find((r) => r.issuedVia === 'renewal')).toMatchObject({
      revokedReason: RENEWAL_ABANDONED,
    })
    expect(announced).toEqual([['agent-runtime', 'pipeline-runner']])
    expect(driver.getNodeAddonIds(NODE)).toEqual(['agent-runtime', 'pipeline-runner'])
  })
})
