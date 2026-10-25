/**
 * Slice 4 / Task 3 — `updateGlobalSettings` gives operators log-visible
 * feedback when `clusterRoles.ingestNode` changes to a node that
 * `resolveIngestOwner` (Task 2) flags with a `configIssue` (unreachable or
 * not ingest-capable). Purely additive: the warn never affects the settings
 * write itself, and `ingestNode='hub'` (default / unchanged) never warns —
 * byte-identical to slice-2 in that case.
 */
import { describe, it, expect, afterEach } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import PipelineOrchestratorAddon from '../index.js'
import { makeFakeContext, makeFakeBroker, enabledNodesFromBroker } from './e2e-helpers.js'

interface WarnCapture {
  readonly logger: IScopedLogger
  readonly warns: Array<{ message: string; meta: unknown }>
}

function makeWarnCapturingLogger(): WarnCapture {
  const warns: Array<{ message: string; meta: unknown }> = []
  const noop = (): void => {}
  const logger: IScopedLogger = {
    debug: noop,
    info: noop,
    warn: (message: string, opts?: { meta?: unknown }) => {
      warns.push({ message, meta: opts?.meta })
    },
    error: noop,
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, warns }
}

describe('PipelineOrchestrator — updateGlobalSettings ingest-owner config-issue warn', () => {
  let addon: PipelineOrchestratorAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('warns when ingestNode changes to an unreachable agent', async () => {
    const broker = makeFakeBroker('hub')
    const { logger, warns } = makeWarnCapturingLogger()
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: enabledNodesFromBroker(broker),
        ingestNode: 'hub',
      },
      logger,
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.updateGlobalSettings({ ingestNode: 'agent-unreachable' })

    const issueWarns = warns.filter((w) => w.message === 'ingest node config issue')
    expect(issueWarns.length).toBe(1)
    expect(issueWarns[0]!.meta).toMatchObject({
      ingestNode: 'agent-unreachable',
      issue: expect.stringMatching(/reachable/i),
    })
  })

  it('does not warn when ingestNode is unchanged (stays hub)', async () => {
    const broker = makeFakeBroker('hub')
    const { logger, warns } = makeWarnCapturingLogger()
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: enabledNodesFromBroker(broker),
        ingestNode: 'hub',
      },
      logger,
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.updateGlobalSettings({ loadShedEnabled: false })

    expect(warns.some((w) => w.message === 'ingest node config issue')).toBe(false)
    const owner = await addon.getIngestOwner()
    expect(owner).toEqual({ ownerNodeId: 'hub' })
  })

  it('does not warn when ingestNode changes to hub explicitly', async () => {
    const broker = makeFakeBroker('hub')
    const { logger, warns } = makeWarnCapturingLogger()
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: enabledNodesFromBroker(broker),
        ingestNode: 'other-hub-alias-not-used',
      },
      logger,
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.updateGlobalSettings({ ingestNode: 'hub' })

    expect(warns.some((w) => w.message === 'ingest node config issue')).toBe(false)
  })
})
