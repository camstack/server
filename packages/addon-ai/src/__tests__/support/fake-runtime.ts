/**
 * One full `RuntimeClient` fake for the hub-side specs. Every verb answers a
 * harmless default and records what reached it; a spec overrides only the
 * verbs its assertion is about, so adding a verb to the seam is one edit here
 * rather than one per spec.
 */
import type {
  AppleFmAvailability,
  LlmGenerateResult,
  LlmRuntimeAppleCompleteInput,
  LlmRuntimeCompleteInput,
} from '@camstack/types'
import type { RuntimeClient } from '../../provider.js'

export const OK_RESULT: LlmGenerateResult = {
  ok: true,
  text: 'local',
  model: 'q',
  usage: { inputTokens: 2, outputTokens: 1 },
  truncated: false,
  latencyMs: 3,
}

export interface RuntimeCalls {
  readonly complete: Array<{ nodeId: string; input: LlmRuntimeCompleteInput }>
  readonly completeApple: Array<{ nodeId: string; input: LlmRuntimeAppleCompleteInput }>
  readonly cancel: Array<{ nodeId: string; requestId: string }>
  readonly appleAvailability: string[]
}

export interface FakeRuntimeHandle {
  readonly runtime: RuntimeClient
  readonly calls: RuntimeCalls
}

export function fakeRuntimeClient(overrides: Partial<RuntimeClient> = {}): FakeRuntimeHandle {
  const calls: RuntimeCalls = { complete: [], completeApple: [], cancel: [], appleAvailability: [] }
  const available: AppleFmAvailability = {
    state: 'available',
    osVersion: '26.3.1',
    contextSize: 4096,
    languages: ['it-IT'],
    imageInput: false,
  }
  const runtime: RuntimeClient = {
    complete: async (nodeId, input) => {
      calls.complete.push({ nodeId, input })
      return OK_RESULT
    },
    completeApple: async (nodeId, input) => {
      calls.completeApple.push({ nodeId, input })
      return { ...OK_RESULT, model: 'apple-system' }
    },
    cancel: async (nodeId, requestId) => {
      calls.cancel.push({ nodeId, requestId })
    },
    appleAvailability: async (nodeId) => {
      calls.appleAvailability.push(nodeId)
      return available
    },
    ensureStarted: async (nodeId) => ({ nodeId, state: 'ready', crashesInWindow: 0 }),
    stopRuntime: async () => undefined,
    status: async (nodeId) => ({ nodeId, state: 'ready', crashesInWindow: 0 }),
    installModel: async () => undefined,
    deleteModel: async () => undefined,
    listLocalModels: async () => [],
    getDiskUsage: async (nodeId) => ({ nodeId, modelsBytes: 0 }),
    listRuntimeNodeIds: async () => ['agent-1'],
    listRegisteredRuntimeNodeIds: async () => ['agent-1', 'mac'],
    ...overrides,
  }
  return { runtime, calls }
}
