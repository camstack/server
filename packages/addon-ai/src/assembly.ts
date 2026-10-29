/**
 * Registration assembly (the hub/agent split, spec §1). Every node running
 * addon-ai registers `llm-runtime`; ONLY the hub also registers the consumer
 * `llm` surface (profiles/usage need outbound internet + API keys).
 * Extracted from the addon class so the split + seeding is unit-testable
 * without a full AddonContext.
 */
import {
  type ILlmProvider,
  type ILlmRuntimeProvider,
  type IScopedLogger,
  llmCapability,
  nodeRemovalHookCapability,
  llmRuntimeCapability,
  type ManagedModelRef,
  type ProviderRegistration,
  type RecordsAccess,
} from '@camstack/types'
import { createLlmClient, type LlmClient } from './client/llm-client.js'
import { DefaultsStore } from './defaults-store.js'
import { ProfileStore } from './profile-store.js'
import { createNodeRemovalHook } from './node-removal.js'
import { createLlmProvider } from './provider.js'
import type { AppleFmBackend } from './runtime/apple/afm-backend.js'
import type { LlamaSupervisor } from './runtime/llama-supervisor.js'
import { LLM_MODEL_CATALOG } from './runtime/llm-model-catalog.js'
import { createDefaultModelOps } from './runtime/model-ops.js'
import { createLlmRuntimeProvider } from './runtime/runtime-provider.js'
import { AppleNodeMirror } from './apple-node-mirror.js'
import { createRuntimeClient, type RuntimeApi } from './runtime-client.js'
import { ChatStore } from './test-chat/chat-store.js'
import type { UsageRecorder } from './usage/usage-port.js'

export interface AiAssemblyDeps {
  readonly nodeId: string
  readonly isHub: boolean
  readonly logger: IScopedLogger
  readonly modelsDir: string
  /** The hub's `ctx.records`, with the AI kinds already declared. Required on the hub; agents carry none. */
  readonly records?: Pick<RecordsAccess, 'kind'>
  readonly supervisor: LlamaSupervisor
  readonly ensureBinary: () => Promise<string>
  /** Overridable so a test can assert the request BODY the library emits. */
  readonly client?: LlmClient
  /** Present on the hub — the runtime client + distributor relay ride it. */
  readonly runtimeApi?: RuntimeApi
  readonly distributeModel?: (nodeId: string, model: ManagedModelRef) => Promise<void>
  /** Every node: Apple Foundation Models (answers unsupported-platform off darwin). */
  readonly apple?: AppleFmBackend
}

export interface AiAssembly {
  readonly registrations: ProviderRegistration[]
  readonly runtimeProvider: ILlmRuntimeProvider
  readonly llmProvider?: ILlmProvider
  readonly store?: ProfileStore
  /** Hub only — the test-chat data-plane writes its own usage row through it,
   *  because a streamed generation never passes through `llmProvider.generate`
   *  and the usage row is the one durable trace a test call leaves. */
  readonly usage?: UsageRecorder
  readonly chats?: ChatStore
}

export async function assembleAi(deps: AiAssemblyDeps): Promise<AiAssembly> {
  // ONE client per node, shared by the node-side runtime and (on the hub) the
  // consumer provider. It holds no per-call state — a provider instance is
  // built per profile inside it.
  const client = deps.client ?? createLlmClient()
  const runtimeProvider = createLlmRuntimeProvider({
    nodeId: deps.nodeId,
    modelsDir: deps.modelsDir,
    ensureBinary: deps.ensureBinary,
    supervisor: deps.supervisor,
    modelOps: createDefaultModelOps(deps.modelsDir),
    client,
    logger: deps.logger.child('llm-runtime'),
    ...(deps.apple !== undefined ? { apple: deps.apple } : {}),
  })
  const registrations: ProviderRegistration[] = [
    { capability: llmRuntimeCapability, provider: runtimeProvider },
  ]

  if (!deps.isHub) {
    return { registrations, runtimeProvider }
  }

  const records = deps.records
  if (records === undefined) throw new Error('addon-ai (hub) needs ctx.records')
  const { UsageStore } = await import('./usage/usage-store.js')
  const store = ProfileStore.of(records, deps.logger.child('llm-profiles'))
  const defaults = DefaultsStore.of(records)
  const usage = UsageStore.of(records, deps.logger.child('llm-usage'))
  const chats = ChatStore.of(records, Date.now)
  // D893: flat rows → providerConfig before anything reads them for real.
  await store.migrateLegacyRows()
  await store.ensureSeeded()

  const runtimeClient =
    deps.runtimeApi !== undefined ? createRuntimeClient(deps.runtimeApi) : undefined
  // Read synchronously by dispatch; refreshed in the background by its own
  // readers (serve-and-revalidate), never awaited on a generation's path.
  const appleNodes =
    runtimeClient !== undefined
      ? new AppleNodeMirror({ source: runtimeClient, logger: deps.logger.child('apple-nodes') })
      : undefined
  const llmProvider = createLlmProvider({
    store,
    defaults,
    usage,
    client,
    ...(runtimeClient !== undefined ? { runtime: runtimeClient } : {}),
    ...(appleNodes !== undefined ? { appleNodes } : {}),
    ...(deps.distributeModel !== undefined ? { distributeModel: deps.distributeModel } : {}),
    catalog: LLM_MODEL_CATALOG.map((m) => m.meta),
    logger: deps.logger.child('llm'),
  })
  registrations.push({ capability: llmCapability, provider: llmProvider })
  registrations.push({
    capability: nodeRemovalHookCapability,
    provider: createNodeRemovalHook({ store, logger: deps.logger.child('node-removal') }),
  })

  return {
    registrations,
    runtimeProvider,
    llmProvider,
    store,
    usage,
    chats,
  }
}
