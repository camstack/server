/**
 * Placement flags (detect, audio, ingest) default ON for every node; only an
 * explicit stored `false` turns a role off. A re-paired agent (new node id, no
 * stored settings) must enter balancing.
 */
import { describe, it, expect, vi } from 'vitest'
import type { IEventBus, IScopedLogger } from '@camstack/types'
import { NodeTopologyService } from '../node-topology.js'
import type { AgentSettingsMapBlob } from '../orchestrator-store-schemas.js'

function makeTopology(blob: AgentSettingsMapBlob): NodeTopologyService {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as IScopedLogger
  const eventBus = { emit: vi.fn(), subscribe: vi.fn() } as unknown as IEventBus
  return new NodeTopologyService({
    readAgentSettingsMap: async () => blob,
    eventBus,
    logger,
    localNodeId: () => 'hub',
    addonId: () => 'pipeline-orchestrator',
  })
}

describe('NodeTopologyService — placement flags default on', () => {
  it('an agent with an empty stored entry is enabled for every role', async () => {
    const topology = makeTopology({ 'mac-new': {} })
    await topology.refreshNodeCapabilities()
    expect(topology.enabledNodes).toEqual(['hub', 'mac-new'])
    expect(topology.enabledAudioNodes).toEqual(['hub', 'mac-new'])
    expect(topology.enabledIngestNodes).toEqual(['hub', 'mac-new'])
  })

  it('an agent online but absent from the stored blob is enabled for every role', async () => {
    const topology = makeTopology({})
    topology.addKnownRunnerNode('mac-new')
    topology.addKnownRunnerNode('hub/classifier')
    await topology.refreshNodeCapabilities()
    expect(topology.enabledNodes).toEqual(['hub', 'mac-new'])
    expect(topology.enabledAudioNodes).toEqual(['hub', 'mac-new'])
    expect(topology.enabledIngestNodes).toEqual(['hub', 'mac-new'])
  })

  it('an explicit false turns only that role off', async () => {
    const topology = makeTopology({ 'mac-new': { detect: false, audio: true } })
    topology.addKnownRunnerNode('mac-new')
    await topology.refreshNodeCapabilities()
    expect(topology.enabledNodes).toEqual(['hub'])
    expect(topology.enabledAudioNodes).toEqual(['hub', 'mac-new'])
    expect(topology.enabledIngestNodes).toEqual(['hub', 'mac-new'])
  })
})
