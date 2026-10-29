/**
 * Placement flags (detect, audio, ingest) default ON for every node; only an
 * explicit stored `false` turns a role off. A re-paired agent (new node id, no
 * stored settings) must enter balancing.
 */
import { describe, it, expect } from 'vitest'
import type { IEventBus, IScopedLogger, LogTags } from '@camstack/types'
import { NodeTopologyService } from '../node-topology.js'
import type { AgentSettingsMapBlob } from '../orchestrator-store-schemas.js'

function makeLogger(): IScopedLogger {
  const self: IScopedLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: (_scope: string) => self,
    withTags: (_tags: LogTags) => self,
  }
  return self
}

function makeEventBus(): IEventBus {
  return {
    emit: () => {},
    subscribe: () => () => {},
    getRecent: () => [],
  }
}

function makeTopology(blob: AgentSettingsMapBlob): NodeTopologyService {
  const logger = makeLogger()
  const eventBus = makeEventBus()
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
    const topology = makeTopology({ 'mac-new': { maxCameras: null } })
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
    const topology = makeTopology({ 'mac-new': { maxCameras: null, detect: false, audio: true } })
    topology.addKnownRunnerNode('mac-new')
    await topology.refreshNodeCapabilities()
    expect(topology.enabledNodes).toEqual(['hub'])
    expect(topology.enabledAudioNodes).toEqual(['hub', 'mac-new'])
    expect(topology.enabledIngestNodes).toEqual(['hub', 'mac-new'])
  })
})
