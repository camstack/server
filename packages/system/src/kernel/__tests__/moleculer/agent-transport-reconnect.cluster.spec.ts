/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- test file, Moleculer internals */
/**
 * D856 amendment (2026-10-15 incident): an agent changes how it dials the hub (a mesh leaf swap
 * and its rollback, a new hub address or secret) by replacing its TRANSPORT, never its broker.
 *
 * It used to stop the broker and build another. `$process.stopped()` SIGTERMed every forked
 * runner ("child … gone"), the new broker had no `$agent-cap-fwd`, and the node came back online
 * and capless: the hub's confirm failed with "Service '$agent-cap-fwd.forward' is not found".
 *
 * REAL-TCP test: the services of the agent broker (here `$agent-cap-fwd` and a `$process`-like
 * service whose `stopped` hook stands for the runner kill) must survive the reconnect and be
 * callable from the hub again, and the hub must be re-announced to the agent (`$node.connected`
 * fires again - that is what re-runs the mesh join).
 */
import { createServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { ServiceBroker } from 'moleculer'
import {
  buildTransporter,
  connectBrokerTransport,
  currentBrokerTransporter,
  disconnectBrokerTransport,
  installBrokerTransporter,
  isInstalledTransporter,
} from '../../moleculer/broker-transport-swap.js'
import {
  createAgentTransport,
  createBroker,
  type BrokerConfig,
} from '../../moleculer/broker-factory.js'
import { generateMeshCa, issueMeshLeafForNode } from '../../moleculer/mesh-mtls/mesh-ca.js'
import { MeshCrl } from '../../moleculer/mesh-mtls/mesh-crl.js'
import { TlsTcpTransporter } from '../../moleculer/mesh-mtls/tls-tcp-transporter.js'

const HUB_TCP_PORT = 16355
const AGENT_ID = 'reconnect-agent'

async function waitUntil(condition: () => boolean, timeout = 20000): Promise<boolean> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeout) return false
    await new Promise((r) => setTimeout(r, 100))
  }
  return true
}

import { describeMeshLeaf } from '../../moleculer/mesh-mtls/mesh-certificate-registry.js'

const describeSerial = (certPem: string): string => describeMeshLeaf(certPem).serial

const available = (broker: ServiceBroker, action: string): boolean =>
  (broker as any).registry.actions.isAvailable(action)

async function tcpUsable(): Promise<boolean> {
  const probe = new ServiceBroker({
    nodeID: 'reconnect-probe',
    transporter: { type: 'TCP', options: { port: 0, udpDiscovery: false } },
    logger: false,
  })
  try {
    await probe.start()
    await probe.stop()
    return true
  } catch {
    return false
  }
}

/** The agent's reconnect, in the exact order main.ts runs it. */
async function reconnectInPlace(
  broker: ServiceBroker,
  config: Omit<BrokerConfig, 'nodeID' | 'mode'>,
): Promise<void> {
  const before = currentBrokerTransporter(broker)
  if (isInstalledTransporter(broker, before)) await disconnectBrokerTransport(broker)
  const next = buildTransporter(
    createAgentTransport({ nodeID: AGENT_ID, mode: 'agent', ...config }),
  )
  installBrokerTransporter(broker, next)
  await connectBrokerTransport(broker)
}

const usable = await tcpUsable()

describe('Agent transport reconnect keeps the broker (D856)', { timeout: 120000 }, () => {
  const brokers: ServiceBroker[] = []
  afterEach(async () => {
    for (const b of [...brokers].toReversed()) await b.stop().catch(() => undefined)
    brokers.length = 0
  })

  it.skipIf(!usable)(
    'services and their lifecycle survive; the hub is rediscovered and calls the agent again',
    async () => {
      const hub = new ServiceBroker({
        nodeID: 'hub',
        serializer: 'MsgPack',
        transporter: {
          type: 'TCP',
          options: { port: HUB_TCP_PORT, udpDiscovery: false },
        },
        logger: false,
      })
      brokers.push(hub)
      hub.createService({
        name: 'hub-cap',
        actions: { ping: { handler: () => 'hub' } },
      })
      await hub.start()

      const agent = createBroker({
        nodeID: AGENT_ID,
        mode: 'agent',
        hubAddress: `127.0.0.1:${HUB_TCP_PORT}`,
        tcpPort: HUB_TCP_PORT,
        logLevel: 'error',
      })
      brokers.push(agent)
      let runnersKilled = 0
      agent.createService({
        name: '$agent-cap-fwd',
        actions: { forward: { handler: () => 'forwarded' } },
      })
      agent.createService({
        name: '$process',
        actions: { list: { handler: () => 'runners' } },
        // The real `$process.stopped()` SIGTERMs every runner.
        stopped() {
          runnersKilled += 1
        },
      })
      let hubConnected = 0
      agent.localBus.on('$node.connected', (payload: any) => {
        if (payload?.node?.id === 'hub') hubConnected += 1
      })
      await agent.start()
      expect(await waitUntil(() => available(hub, '$agent-cap-fwd.forward'))).toBe(true)
      expect(await waitUntil(() => available(agent, 'hub-cap.ping'))).toBe(true)
      const connectedBefore = hubConnected

      await reconnectInPlace(agent, {
        hubAddress: `127.0.0.1:${HUB_TCP_PORT}`,
        tcpPort: HUB_TCP_PORT,
      })

      // The hub finds `$agent-cap-fwd` on the SAME broker again: it is routable.
      expect(await waitUntil(() => available(hub, '$agent-cap-fwd.forward'))).toBe(true)
      expect(await hub.call('$agent-cap-fwd.forward')).toBe('forwarded')
      expect(await hub.call('$process.list')).toBe('runners')
      // No runner was stopped by the reconnect.
      expect(runnersKilled).toBe(0)
      // The agent sees the hub as a NEW connection, so the mesh join runs again.
      expect(await waitUntil(() => available(agent, 'hub-cap.ping'))).toBe(true)
      expect(hubConnected).toBeGreaterThan(connectedBefore)
      expect(await agent.call('hub-cap.ping')).toBe('hub')
    },
  )

  it.skipIf(!usable)(
    'mutual TLS: swapping to a NEW leaf of the same CA keeps the services and reconnects with it',
    async () => {
      const HUB_CLEAR = 16356
      const HUB_TLS = 16357
      const AGENT_TLS = 16358
      const AGENT_CLEAR = 16359
      const ca = await generateMeshCa()
      const hubLeaf = await issueMeshLeafForNode(ca, 'hub')
      const firstLeaf = await issueMeshLeafForNode(ca, AGENT_ID)
      const material = (leaf: { certPem: string; keyPem: string }) => ({
        caCertPem: ca.certPem,
        certPem: leaf.certPem,
        keyPem: leaf.keyPem,
      })

      const hub = new ServiceBroker({
        nodeID: 'hub',
        serializer: 'MsgPack',
        // @ts-expect-error TlsTcpTransporter is a TcpTransporter subclass.
        transporter: new TlsTcpTransporter({
          port: HUB_CLEAR,
          tlsPort: HUB_TLS,
          hubTlsOnly: true,
          udpDiscovery: false,
          crl: new MeshCrl(),
          meshTls: material(hubLeaf),
        }),
        logger: false,
        metrics: { enabled: false },
      })
      brokers.push(hub)
      await hub.start()

      const agentConfig = (leaf: {
        certPem: string
        keyPem: string
      }): Omit<BrokerConfig, 'nodeID' | 'mode'> => ({
        hubAddress: '127.0.0.1',
        tcpPort: HUB_CLEAR,
        tlsPort: HUB_TLS,
        agentListenPort: AGENT_CLEAR,
        agentTlsListenPort: AGENT_TLS,
        meshTls: material(leaf),
      })
      const agent = createBroker({
        nodeID: AGENT_ID,
        mode: 'agent',
        logLevel: 'error',
        ...agentConfig(firstLeaf),
      })
      brokers.push(agent)
      let runnersKilled = 0
      agent.createService({
        name: '$agent-cap-fwd',
        actions: { forward: { handler: () => 'forwarded' } },
      })
      agent.createService({
        name: '$process',
        actions: { list: { handler: () => 'runners' } },
        stopped() {
          runnersKilled += 1
        },
      })
      await agent.start()
      expect(await waitUntil(() => available(hub, '$agent-cap-fwd.forward'))).toBe(true)

      const secondLeaf = await issueMeshLeafForNode(ca, AGENT_ID)
      await reconnectInPlace(agent, agentConfig(secondLeaf))

      expect(await waitUntil(() => available(hub, '$agent-cap-fwd.forward'))).toBe(true)
      expect(await hub.call('$agent-cap-fwd.forward')).toBe('forwarded')
      expect(runnersKilled).toBe(0)
      const presented = (hub as any).transit.tx.peerLeaf(AGENT_ID)
      expect(presented?.serial).toBe(describeSerial(secondLeaf.certPem))
    },
  )

  it.skipIf(!usable)(
    'a failed connect followed by a swap leaves one reader, one writer and no EADDRINUSE',
    async () => {
      const PORT = 16360
      const hub = new ServiceBroker({
        nodeID: 'hub',
        serializer: 'MsgPack',
        transporter: { type: 'TCP', options: { port: 16361, udpDiscovery: false } },
        logger: false,
      })
      brokers.push(hub)
      await hub.start()
      const config = { hubAddress: '127.0.0.1:16361', tcpPort: 16361, agentListenPort: PORT }
      const agent = createBroker({ nodeID: AGENT_ID, mode: 'agent', logLevel: 'error', ...config })
      brokers.push(agent)
      agent.createService({ name: 'agent-cap', actions: { ping: { handler: () => 'pong' } } })
      await agent.start()
      expect(await waitUntil(() => available(hub, 'agent-cap.ping'))).toBe(true)

      // The agent's reader port is taken, so the NEXT transporter's connect fails.
      await disconnectBrokerTransport(agent)
      const blocker = createServer()
      await new Promise<void>((resolve) => blocker.listen(PORT, resolve))
      const failing = buildTransporter(
        createAgentTransport({ nodeID: AGENT_ID, mode: 'agent', ...config }),
      )
      installBrokerTransporter(agent, failing)
      void connectBrokerTransport(agent).catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 500))
      await new Promise<void>((resolve) => blocker.close(() => resolve()))

      // Swap to a new transporter BEFORE Moleculer's 5 s connect retry fires.
      await disconnectBrokerTransport(agent)
      const good = buildTransporter(
        createAgentTransport({ nodeID: AGENT_ID, mode: 'agent', ...config }),
      )
      installBrokerTransporter(agent, good)
      await connectBrokerTransport(agent)
      expect(await waitUntil(() => available(hub, 'agent-cap.ping'))).toBe(true)

      // The retry timer of the failed connect fires now, on the newer transporter: it must not
      // run startTcpServer a second time (it would hit EADDRINUSE and orphan the live server).
      await new Promise((resolve) => setTimeout(resolve, 6500))
      const tx: any = (agent as any).transit.tx
      expect(tx).toBe(good.tx)
      expect(tx.connected).toBe(true)
      expect(await hub.call('agent-cap.ping')).toBe('pong')
      // And a further swap still binds the port.
      await reconnectInPlace(agent, config)
      expect(await waitUntil(() => available(hub, 'agent-cap.ping'))).toBe(true)
      expect(await hub.call('agent-cap.ping')).toBe('pong')
    },
  )
})
