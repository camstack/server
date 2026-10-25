/**
 * `llm.cancel` must reach a generation that runs on ANOTHER node.
 *
 * Before: the hub's cancel only aborted its own `inFlight` map, the
 * managed-local branch never registered there, and the node generated with
 * `new AbortController().signal` — so a gate that gave up at 8 s left the
 * node's model generating to its own timeout. Both halves are pinned here.
 */
import type {
  LlmGenerateResult,
  LlmRuntimeStatus,
  ManagedRuntimeConfig,
  ModelCatalogEntry,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { LlmCallRequest, LlmClient } from '../client/llm-client.js'
import { DefaultsStore } from '../defaults-store.js'
import { ProfileStore } from '../profile-store.js'
import { createLlmProvider } from '../provider.js'
import type { LlamaStartConfig } from '../runtime/llama-supervisor.js'
import {
  createLlmRuntimeProvider,
  type RuntimeModelOps,
  type RuntimeSupervisor,
} from '../runtime/runtime-provider.js'
import { makeAiRecords } from './support/fake-records.js'
import type { UsageRecorder } from '../usage/usage-port.js'
import { fakeRuntimeClient } from './support/fake-runtime.js'
import { createTestLogger, makeTestLogger } from './support/logger.js'
import { makeProfile } from './support/profile.js'

const CATALOG_ID = 'llm-qwen2.5-1.5b-instruct-q4'

const runtimeCfg: ManagedRuntimeConfig = {
  nodeId: 'agent-1',
  engine: 'llama-cpp',
  model: { kind: 'catalog', catalogId: CATALOG_ID },
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

const boots: LlamaStartConfig[] = []

function readySupervisor(): RuntimeSupervisor {
  const status = (): LlmRuntimeStatus => ({ nodeId: 'agent-1', state: 'ready', crashesInWindow: 0 })
  return {
    start: async (cfg: LlamaStartConfig) => {
      boots.push(cfg)
      return status()
    },
    stop: async () => undefined,
    status,
    noteActivity: () => undefined,
    port: 18080,
  }
}

const installedOps: RuntimeModelOps = {
  ensure: async (entry: ModelCatalogEntry) => `/models/${entry.id}.gguf`,
  isDownloaded: () => true,
  pathFor: (entry) => `/models/${entry.id}.gguf`,
  delete: async () => undefined,
  extraFilePath: (_entry, filename) => `/models/${filename}`,
}

/** A client that answers only once the signal it was handed aborts. */
function hangingClient(): { client: LlmClient; requests: LlmCallRequest[] } {
  const requests: LlmCallRequest[] = []
  const client: LlmClient = {
    supports: () => true,
    generate: (request) => {
      requests.push(request)
      return new Promise<LlmGenerateResult>((resolve) => {
        request.signal.addEventListener('abort', () =>
          resolve({ ok: false, code: 'timeout', message: 'the call was cancelled' }),
        )
      })
    },
    openStream: async () => ({ kind: 'unsupported' }),
  }
  return { client, requests }
}

function nodeProvider(client: LlmClient) {
  return createLlmRuntimeProvider({
    nodeId: 'agent-1',
    modelsDir: '/models',
    ensureBinary: async () => '/bin/llama-server',
    supervisor: readySupervisor(),
    modelOps: installedOps,
    client,
    logger: makeTestLogger(),
  })
}

async function tick(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('llm-runtime cancel (node side)', () => {
  it('cancel({ requestId }) aborts the signal the local client is holding', async () => {
    const { client, requests } = hangingClient()
    const node = nodeProvider(client)
    const pending = node.complete({
      consumer: 'c',
      prompt: 'q',
      runtime: runtimeCfg,
      requestId: 'r1',
    })
    await tick()
    expect(requests).toHaveLength(1)
    expect(requests[0]?.signal.aborted).toBe(false)
    await node.cancel({ requestId: 'r1' })
    expect(requests[0]?.signal.aborted).toBe(true)
    expect(await pending).toMatchObject({ ok: false, code: 'timeout' })
  })

  it('a cancel that arrives BEFORE its generation still stops it', async () => {
    const { client, requests } = hangingClient()
    const node = nodeProvider(client)
    boots.length = 0
    await node.cancel({ requestId: 'early' })
    const result = await node.complete({
      consumer: 'c',
      prompt: 'q',
      runtime: runtimeCfg,
      requestId: 'early',
    })
    expect(result).toMatchObject({ ok: false, code: 'timeout' })
    expect(requests).toHaveLength(0)
    // …and it never paid for a llama-server boot either.
    expect(boots).toHaveLength(0)
  })

  it('cancelling an unknown id is a no-op that resolves', async () => {
    const node = nodeProvider(hangingClient().client)
    await expect(node.cancel({ requestId: 'never' })).resolves.toBeUndefined()
  })
})

class NullUsage implements UsageRecorder {
  async record(): Promise<void> {}
  async rollup(): Promise<never[]> {
    return []
  }
}

async function hubWith(
  runtime: ReturnType<typeof fakeRuntimeClient>['runtime'],
  logger = makeTestLogger(),
) {
  const { records } = await makeAiRecords()
  const store = ProfileStore.of(records)
  const defaults = DefaultsStore.of(records)
  await store.upsert(makeProfile({ id: 'm', kind: 'managed-local', runtime: runtimeCfg }))
  await defaults.set({ purpose: 'text' }, 'm')
  return createLlmProvider({
    store,
    defaults,
    client: hangingClient().client,
    usage: new NullUsage(),
    runtime,
    logger,
  })
}

describe('llm.cancel (hub side) for a generation on another node', () => {
  it('forwards to llmRuntime.cancel on the node the generation was pinned to', async () => {
    let finish: (r: LlmGenerateResult) => void = () => {}
    const { runtime, calls } = fakeRuntimeClient({
      complete: () =>
        new Promise<LlmGenerateResult>((resolve) => {
          finish = resolve
        }),
    })
    const hub = await hubWith(runtime)
    const pending = hub.generate({ consumer: 'notifier-rules', prompt: 'q', requestId: 'r9' })
    await tick()
    await hub.cancel({ requestId: 'r9' })
    expect(calls.cancel).toEqual([{ nodeId: 'agent-1', requestId: 'r9' }])
    finish({ ok: false, code: 'timeout', message: 'the call was cancelled' })
    await pending
  })

  it('once the generation finished, cancelling it reaches nobody', async () => {
    const { runtime, calls } = fakeRuntimeClient()
    const hub = await hubWith(runtime)
    await hub.generate({ consumer: 'notifier-rules', prompt: 'q', requestId: 'r10' })
    await hub.cancel({ requestId: 'r10' })
    expect(calls.cancel).toHaveLength(0)
  })

  it('a node that cannot be reached for the cancel is logged, never thrown at the caller', async () => {
    let finish: (r: LlmGenerateResult) => void = () => {}
    const { logger, entries } = createTestLogger()
    const { runtime } = fakeRuntimeClient({
      complete: () =>
        new Promise<LlmGenerateResult>((resolve) => {
          finish = resolve
        }),
      cancel: async () => {
        throw new Error('node offline')
      },
    })
    const hub = await hubWith(runtime, logger)
    const pending = hub.generate({ consumer: 'notifier-rules', prompt: 'q', requestId: 'r11' })
    await tick()
    await expect(hub.cancel({ requestId: 'r11' })).resolves.toBeUndefined()
    expect(entries.some((e) => e.level === 'warn' && e.message.includes('cancel'))).toBe(true)
    finish({ ok: false, code: 'timeout', message: 'x' })
    await pending
  })
})
