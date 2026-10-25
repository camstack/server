import { describe, expect, it, afterEach } from 'vitest'
import { assignNodeColorId } from '@camstack/types'
import PipelineOrchestratorAddon from '../index.js'
import { makeFakeContext, makeFakeBroker, enabledNodesFromBroker } from './e2e-helpers.js'

describe('assignNodeColorId', () => {
  it('is stable for the same nodeId', () => {
    expect(assignNodeColorId('hub')).toBe(assignNodeColorId('hub'))
  })

  it('returns a palette id', () => {
    expect(assignNodeColorId('proxmox')).toMatch(/^node-[a-h]$/)
  })
})

describe('PipelineOrchestrator — agent node colour', () => {
  let addon: PipelineOrchestratorAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('setAgentReachableHost persists colour without clearing reachableHost', async () => {
    const broker = makeFakeBroker('hub')
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.setAgentReachableHost({ agentNodeId: 'hub', reachableHost: '10.0.0.1' })
    await addon.setAgentReachableHost({ agentNodeId: 'hub', color: 'node-c' })

    const settings = await addon.getAgentSettings({ agentNodeId: 'hub' })
    expect(settings?.reachableHost).toBe('10.0.0.1')
    expect(settings?.color).toBe('node-c')
  })

  it('listAgentSettings seeds colour when absent and keeps it stable', async () => {
    const broker = makeFakeBroker('hub')
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.setAgentMaxCameras({ agentNodeId: 'hub', maxCameras: 5 })

    const first = await addon.listAgentSettings()
    const hubFirst = first.find((e) => e.nodeId === 'hub')
    expect(hubFirst?.settings.color).toMatch(/^node-[a-h]$/)

    const second = await addon.listAgentSettings()
    const hubSecond = second.find((e) => e.nodeId === 'hub')
    expect(hubSecond?.settings.color).toBe(hubFirst?.settings.color)
  })
})
