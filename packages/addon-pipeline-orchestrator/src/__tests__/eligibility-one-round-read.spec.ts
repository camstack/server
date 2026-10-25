/**
 * D650 pre-ship — a read nothing waits on takes ONE round (D3).
 *
 * `resolveEligibleInferenceDevices` awaits the node's catalog for a first
 * placement. The same function is the session controller's balancer memo
 * `load`, driven by a background refresher for every node a session was ever
 * dispatched to. For a node that has DEPARTED (a Mac asleep) the unbounded form
 * loops forever: a `getSchema` plus an acquire wait per round and a WARN every
 * round. The refresher now asks for `one-round`: the read settles within one
 * round, fails (so the memo keeps its last answer), and warns nothing.
 */
import type { IScopedLogger } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import PipelineOrchestratorAddon from '../index.js'
import {
  makeFakeBroker,
  makeFakeContext,
  makeFakeRunner,
  makeSilentLogger,
  wireRunnerToBroker,
} from './e2e-helpers.js'

const NODE = 'agent-a'

/** Well under the 30 s acquire round the unbounded form would pay per loop. */
const SETTLE_BOUND_MS = 3_000

async function settledWithin<T>(p: Promise<T>, ms: number): Promise<'settled' | 'hung'> {
  const settled = p.then(
    () => 'settled' as const,
    () => 'settled' as const,
  )
  const hung = new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), ms))
  return Promise.race([settled, hung])
}

describe('eligibility read on a departed node (D650 pre-ship, D3)', () => {
  let addon: PipelineOrchestratorAddon | null = null

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('one-round: settles within one round, fails, and warns nothing', async () => {
    const broker = makeFakeBroker('hub')
    const runner = makeFakeRunner({ nodeId: NODE })
    wireRunnerToBroker(broker, NODE, runner)
    broker.addNode(NODE)
    const warns: string[] = []
    const logger: IScopedLogger = {
      ...makeSilentLogger(),
      warn: (message: string) => void warns.push(message),
    }
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: [NODE] },
      logger,
      providers: {
        // The node's executor never answers again.
        'pipeline-executor': {
          getSchema: () => Promise.reject(new Error('node departed')),
        },
      },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    const read = addon.resolveEligibleInferenceDevices(NODE, 'one-round')
    expect(await settledWithin(read, SETTLE_BOUND_MS)).toBe('settled')
    await expect(read).rejects.toThrow(/catalog not answered/)
    // The per-round "waiting one more round" line never fires: there was one round.
    expect(warns.filter((w) => w.startsWith('executor reconcile'))).toEqual([])
  })
})
