/**
 * `RuntimeClient` over the cap plane — every verb pins the target node with
 * `nodePin(nodeId)` (transport-level, never a hand-rolled routing field). The
 * CapRouteResolver classifies the pin into hub-local-uds / remote-moleculer /
 * agent-child-forward transparently (spec §4.1; the model-studio cross-node
 * convert precedent). Node enumeration is the `nodes.topology` roster filtered
 * to nodes advertising the `llm-runtime` cap — never a shadow registry.
 */
import {
  type AppleFmAvailability,
  type LlmGenerateResult,
  nodePin,
  type LlmNodeModel,
  type LlmRuntimeAppleCompleteInput,
  type LlmRuntimeCompleteInput,
  type LlmRuntimeDiskUsage,
  type LlmRuntimeStatus,
  type ManagedModelRef,
  type ManagedRuntimeConfig,
} from '@camstack/types'
import type { RuntimeClient } from './provider.js'

interface PinOpts {
  readonly context: Readonly<Record<string, string>>
}

interface TopologyAddon {
  readonly capabilities: readonly string[]
}
/** The slice of the registry's `CapabilityInfo` this client reads. */
interface RegisteredCapability {
  readonly perNode?: readonly { readonly nodeId: string }[]
}
interface TopologyNode {
  readonly id: string
  readonly addons: readonly TopologyAddon[]
}

/** The narrow slice of `AddonApi` the runtime client uses. `ctx.api` (the full
 *  tRPC client) satisfies this structurally. */
export interface RuntimeApi {
  readonly llmRuntime: {
    readonly complete: {
      mutate(input: LlmRuntimeCompleteInput, opts?: PinOpts): Promise<LlmGenerateResult>
    }
    readonly completeApple: {
      mutate(input: LlmRuntimeAppleCompleteInput, opts?: PinOpts): Promise<LlmGenerateResult>
    }
    readonly cancel: { mutate(input: { requestId: string }, opts?: PinOpts): Promise<void> }
    readonly appleAvailability: {
      query(input: Record<never, never>, opts?: PinOpts): Promise<AppleFmAvailability>
    }
    readonly ensureStarted: {
      mutate(input: { runtime: ManagedRuntimeConfig }, opts?: PinOpts): Promise<LlmRuntimeStatus>
    }
    readonly stop: { mutate(input: Record<never, never>, opts?: PinOpts): Promise<void> }
    readonly status: {
      query(input: Record<never, never>, opts?: PinOpts): Promise<LlmRuntimeStatus>
    }
    readonly installModel: {
      mutate(input: { model: ManagedModelRef }, opts?: PinOpts): Promise<void>
    }
    readonly deleteModel: { mutate(input: { file: string }, opts?: PinOpts): Promise<void> }
    readonly listLocalModels: {
      query(input: Record<never, never>, opts?: PinOpts): Promise<LlmNodeModel[]>
    }
    readonly getDiskUsage: {
      query(input: Record<never, never>, opts?: PinOpts): Promise<LlmRuntimeDiskUsage>
    }
  }
  readonly nodes: {
    readonly topology: { query(): Promise<readonly TopologyNode[]> }
  }
  readonly capabilities: {
    readonly getCapability: {
      query(input: { name: string }): Promise<RegisteredCapability | null>
    }
  }
}

const LLM_RUNTIME_CAP = 'llm-runtime'

export function createRuntimeClient(api: RuntimeApi): RuntimeClient {
  return {
    complete: (nodeId, input) => api.llmRuntime.complete.mutate(input, nodePin(nodeId)),
    completeApple: (nodeId, input) => api.llmRuntime.completeApple.mutate(input, nodePin(nodeId)),
    cancel: (nodeId, requestId) => api.llmRuntime.cancel.mutate({ requestId }, nodePin(nodeId)),
    appleAvailability: (nodeId) => api.llmRuntime.appleAvailability.query({}, nodePin(nodeId)),
    ensureStarted: (nodeId, runtime) =>
      api.llmRuntime.ensureStarted.mutate({ runtime }, nodePin(nodeId)),
    stopRuntime: (nodeId) => api.llmRuntime.stop.mutate({}, nodePin(nodeId)),
    status: (nodeId) => api.llmRuntime.status.query({}, nodePin(nodeId)),
    installModel: (nodeId, model) => api.llmRuntime.installModel.mutate({ model }, nodePin(nodeId)),
    deleteModel: (nodeId, file) => api.llmRuntime.deleteModel.mutate({ file }, nodePin(nodeId)),
    listLocalModels: (nodeId) => api.llmRuntime.listLocalModels.query({}, nodePin(nodeId)),
    getDiskUsage: (nodeId) => api.llmRuntime.getDiskUsage.query({}, nodePin(nodeId)),
    listRegisteredRuntimeNodeIds: async () => {
      const info = await api.capabilities.getCapability.query({ name: LLM_RUNTIME_CAP })
      // No entry is "no answer", not "no nodes": an empty list here would
      // declare every Apple node offline on a registry that is still booting.
      if (info === null || info.perNode === undefined) return null
      return info.perNode.map((n) => n.nodeId)
    },
    listRuntimeNodeIds: async () => {
      const topology = await api.nodes.topology.query()
      const ids = new Set<string>()
      for (const node of topology) {
        if (node.addons.some((a) => a.capabilities.includes(LLM_RUNTIME_CAP))) {
          ids.add(node.id)
        }
      }
      return [...ids]
    },
  }
}
