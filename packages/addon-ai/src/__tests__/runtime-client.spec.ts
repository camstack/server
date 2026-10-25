import { type LlmRuntimeCompleteInput, type ManagedRuntimeConfig, nodePin } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { createRuntimeClient, type RuntimeApi } from '../runtime-client.js'

const runtime: ManagedRuntimeConfig = {
  nodeId: 'agent-1',
  engine: 'llama-cpp',
  model: { kind: 'catalog', catalogId: 'x' },
  contextSize: 4096,
  gpuLayers: 0,
  parallel: 1,
  flashAttention: false,
  mlock: false,
  noMmap: false,
  extraArgs: [],
  autoStart: false,
  idleStopMinutes: 30,
}

interface Call {
  method: string
  input: unknown
  opts: unknown
}

function fakeApi(
  topology: RuntimeApi['nodes']['topology'] extends { query(): Promise<infer T> } ? T : never = [],
): {
  api: RuntimeApi
  calls: Call[]
} {
  const calls: Call[] = []
  const rec = (method: string) => async (input: unknown, opts?: unknown) => {
    calls.push({ method, input, opts })
    return undefined as never
  }
  const api: RuntimeApi = {
    llmRuntime: {
      complete: { mutate: rec('complete') },
      ensureStarted: { mutate: rec('ensureStarted') },
      stop: { mutate: rec('stop') },
      status: { query: rec('status') },
      installModel: { mutate: rec('installModel') },
      deleteModel: { mutate: rec('deleteModel') },
      listLocalModels: { query: rec('listLocalModels') },
      getDiskUsage: { query: rec('getDiskUsage') },
      completeApple: { mutate: rec('completeApple') },
      cancel: { mutate: rec('cancel') },
      appleAvailability: { query: rec('appleAvailability') },
    },
    nodes: { topology: { query: async () => topology } },
    capabilities: {
      getCapability: {
        query: async ({ name }) =>
          name === 'llm-runtime' ? { perNode: [{ nodeId: 'hub' }, { nodeId: 'mac' }] } : null,
      },
    },
  }
  return { api, calls }
}

describe('createRuntimeClient', () => {
  it('pins every runtime verb with nodePin(nodeId) as the second arg', async () => {
    const { api, calls } = fakeApi()
    const client = createRuntimeClient(api)
    const input: LlmRuntimeCompleteInput = { consumer: 'c', prompt: 'q', runtime }
    await client.complete('agent-1', input)
    await client.ensureStarted('agent-1', runtime)
    await client.stopRuntime('agent-1')
    await client.status('agent-1')
    await client.installModel('agent-1', { kind: 'catalog', catalogId: 'x' })
    await client.deleteModel('agent-1', 'a.gguf')
    await client.listLocalModels('agent-1')
    await client.getDiskUsage('agent-1')
    await client.completeApple('agent-1', { consumer: 'c', prompt: 'q' })
    await client.cancel('agent-1', 'r1')
    await client.appleAvailability('agent-1')
    for (const call of calls) {
      expect(call.opts).toEqual(nodePin('agent-1'))
    }
    expect(calls.map((c) => c.method)).toEqual([
      'complete',
      'ensureStarted',
      'stop',
      'status',
      'installModel',
      'deleteModel',
      'listLocalModels',
      'getDiskUsage',
      'completeApple',
      'cancel',
      'appleAvailability',
    ])
    expect(calls.find((c) => c.method === 'cancel')?.input).toEqual({ requestId: 'r1' })
  })

  it('complete forwards the full input untouched', async () => {
    const { api, calls } = fakeApi()
    const client = createRuntimeClient(api)
    const input: LlmRuntimeCompleteInput = { consumer: 'c', prompt: 'q', runtime, timeoutMs: 9000 }
    await client.complete('agent-1', input)
    expect(calls[0]!.input).toEqual(input)
  })

  it('listRegisteredRuntimeNodeIds reads the REGISTRY, not the topology walk', async () => {
    const { api } = fakeApi()
    expect(await createRuntimeClient(api).listRegisteredRuntimeNodeIds()).toEqual(['hub', 'mac'])
  })

  it('a registry with no llm-runtime entry answers null — "no answer", never "no nodes"', async () => {
    const { api } = fakeApi()
    const empty: RuntimeApi = {
      ...api,
      capabilities: { getCapability: { query: async () => null } },
    }
    expect(await createRuntimeClient(empty).listRegisteredRuntimeNodeIds()).toBeNull()
  })

  it('listRuntimeNodeIds filters topology to llm-runtime hosts and dedups', async () => {
    const { api } = fakeApi([
      { id: 'hub', addons: [{ capabilities: ['llm', 'llm-runtime'] }] },
      { id: 'agent-1', addons: [{ capabilities: ['llm-runtime'] }, { capabilities: ['decoder'] }] },
      { id: 'agent-2', addons: [{ capabilities: ['decoder'] }] },
    ])
    const client = createRuntimeClient(api)
    const ids = await client.listRuntimeNodeIds()
    expect(ids.sort()).toEqual(['agent-1', 'hub'])
  })
})
