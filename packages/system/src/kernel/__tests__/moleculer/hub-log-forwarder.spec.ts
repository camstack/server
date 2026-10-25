/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- test file, mock typing */
import { describe, it, expect, vi } from 'vitest'
import { HubLogForwarder } from '../../moleculer/hub-log-forwarder.js'

function createMockBroker() {
  const eventHandlers = new Map<string, Function>()
  return {
    nodeID: 'test-agent',
    call: vi.fn(async () => true),
    localBus: {
      on: vi.fn((event: string, handler: Function) => {
        eventHandlers.set(event, handler)
      }),
    },
    registry: {
      getNodeList: vi.fn(() => []),
    },
    // Simulate node discovery
    simulateHubConnected: () => eventHandlers.get('$node.connected')?.({ node: { id: 'hub' } }),
    simulateHubDisconnected: () =>
      eventHandlers.get('$node.disconnected')?.({ node: { id: 'hub' } }),
  }
}

const entry = {
  timestamp: new Date(),
  level: 'info',
  scope: 'download',
  message: 'Model download complete',
  tags: { addonId: 'detection-pipeline', nodeId: 'test-agent' },
}

describe('HubLogForwarder', () => {
  it('does not forward before hub is discovered', async () => {
    const broker = createMockBroker()
    const forwarder = new HubLogForwarder(broker as any)
    await forwarder.initialize()

    forwarder.write(entry)

    expect(broker.call).not.toHaveBeenCalled()
  })

  it('forwards after hub node connects', async () => {
    const broker = createMockBroker()
    const forwarder = new HubLogForwarder(broker as any)
    await forwarder.initialize()

    broker.simulateHubConnected()
    forwarder.write(entry)

    expect(broker.call).toHaveBeenCalledWith(
      '$hub.log',
      expect.objectContaining({
        level: 'info',
        message: 'Model download complete',
        addonId: 'detection-pipeline',
        nodeId: 'test-agent',
      }),
    )
  })

  it('pauses on hub disconnect, resumes on reconnect', async () => {
    const broker = createMockBroker()
    const forwarder = new HubLogForwarder(broker as any)
    await forwarder.initialize()

    broker.simulateHubConnected()
    forwarder.write(entry)
    expect(broker.call).toHaveBeenCalledTimes(1)

    broker.simulateHubDisconnected()
    forwarder.write(entry)
    expect(broker.call).toHaveBeenCalledTimes(1) // no new call

    broker.simulateHubConnected()
    forwarder.write(entry)
    expect(broker.call).toHaveBeenCalledTimes(2) // resumed
  })

  it('registers both connect and disconnect listeners', async () => {
    const broker = createMockBroker()
    const forwarder = new HubLogForwarder(broker as any)
    await forwarder.initialize()

    expect(broker.localBus.on).toHaveBeenCalledWith('$node.connected', expect.any(Function))
    expect(broker.localBus.on).toHaveBeenCalledWith('$node.disconnected', expect.any(Function))
  })

  it('ignores non-hub node events', async () => {
    const broker = createMockBroker()
    const forwarder = new HubLogForwarder(broker as any)
    await forwarder.initialize()

    // Simulate a different node connecting
    const handler = (broker.localBus.on as any).mock.calls.find(
      (c: any) => c[0] === '$node.connected',
    )?.[1]
    handler?.({ node: { id: 'some-other-node' } })

    forwarder.write(entry)
    expect(broker.call).not.toHaveBeenCalled()
  })

  it('activates immediately if hub already in registry', async () => {
    const broker = createMockBroker()
    broker.registry.getNodeList = vi.fn(() => [{ id: 'hub' }, { id: 'hub/worker' }])

    const forwarder = new HubLogForwarder(broker as any)
    await forwarder.initialize()

    forwarder.write(entry)
    expect(broker.call).toHaveBeenCalled()
  })

  it('stops after shutdown', async () => {
    const broker = createMockBroker()
    const forwarder = new HubLogForwarder(broker as any)
    await forwarder.initialize()
    broker.simulateHubConnected()

    await forwarder.shutdown()
    forwarder.write(entry)
    expect(broker.call).not.toHaveBeenCalled()
  })

  it('falls back to `agent` addonId when tags missing', async () => {
    const broker = createMockBroker()
    const forwarder = new HubLogForwarder(broker as any)
    await forwarder.initialize()
    broker.simulateHubConnected()

    forwarder.write({
      timestamp: new Date(),
      level: 'warn',
      message: 'test',
    })

    expect(broker.call).toHaveBeenCalledWith(
      '$hub.log',
      expect.objectContaining({
        addonId: 'agent',
        nodeId: 'test-agent',
      }),
    )
  })
})
