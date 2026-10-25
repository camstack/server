/**
 * AI addon — hosts the consumer-facing `llm` collection provider (hub only) and
 * the per-node `llm-runtime` managed llama.cpp executor (every node it is
 * installed on). The hub/agent registration split + seeding live in
 * `assembleAi`; this class only gathers AddonContext fields and schedules the
 * best-effort post-boot tasks (chat prune + autoStart warm-up).
 */
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type AddonApi,
  type AddonDataPlaneHandle,
  BaseAddon,
  type ManagedModelRef,
  type MediaFileKind,
  type ModelCatalogEntry,
  type ProviderRegistration,
} from '@camstack/types'
import { assembleAi } from './assembly.js'
import { createLlmClient } from './client/llm-client.js'
import { managedRuntimeOf } from './kinds/provider-config.js'
import { AppleFmAvailabilityMirror } from './runtime/apple/afm-availability.js'
import { createAppleFmBackend } from './runtime/apple/afm-backend.js'
import { AppleFmHelper } from './runtime/apple/afm-helper.js'
import { LlamaSupervisor } from './runtime/llama-supervisor.js'
import { entryForRef } from './runtime/llm-model-catalog.js'
import type { RuntimeApi } from './runtime-client.js'
import { aiRecordKinds } from './record-kinds.js'
import type { ChatRetention } from './test-chat/chat-store.js'
import { TEST_CHAT_CONSUMER, TEST_CHAT_PREFIX } from './test-chat/contract.js'
import type { TrackMediaRow } from './test-chat/media.js'
import { createTestChatPlaneHandler } from './test-chat/plane.js'
import type { TestChatStreamDeps } from './test-chat/run-stream.js'

interface AiConfig {
  readonly chatRetentionMaxAgeDays: number
  readonly chatRetentionMaxCount: number
}

const POST_BOOT_DELAY_MS = 15_000
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The prebuilt helper, shipped in the package (`files: native`). `import.meta.url`
 * is `dist/<entry>.js` in the bundle and `src/addon.ts` from source — one level
 * under the package root either way.
 */
function appleHelperBinaryPath(): string {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  return path.join(packageRoot, 'native', 'afm', 'camstack-afm')
}

interface DistributorApi {
  readonly modelDistributor: {
    readonly distributeModel: {
      // `targetNodeId`, not `nodeId`: a field named `nodeId` is consumed as a
      // route pin by the cap router (see model-distributor.cap.ts).
      mutate(input: {
        targetNodeId: string
        modelId: string
        format: 'gguf'
        entry: ModelCatalogEntry
      }): Promise<unknown>
    }
  }
}

export class AiAddon extends BaseAddon<AiConfig> {
  private supervisor: LlamaSupervisor | undefined
  private appleHelper: AppleFmHelper | undefined
  private appleMirror: AppleFmAvailabilityMirror | undefined
  private readonly timers: Array<ReturnType<typeof setTimeout>> = []
  /** Hub only — see `serveTestChatPlane`. */
  private testChatPlane: AddonDataPlaneHandle | null = null

  constructor() {
    super({
      chatRetentionMaxAgeDays: 30,
      chatRetentionMaxCount: 50,
    })
  }

  protected globalSettingsSchema() {
    return this.schema({
      sections: [
        {
          id: 'chats',
          title: 'Persistent chats',
          fields: [
            this.field({
              type: 'number',
              key: 'chatRetentionMaxAgeDays',
              label: 'Chat retention (days)',
              description: 'Drop persisted chats older than this. 0 keeps them forever.',
              min: 0,
              step: 1,
              default: 30,
            }),
            this.field({
              type: 'number',
              key: 'chatRetentionMaxCount',
              label: 'Max chats per user',
              description: 'Keep only the newest N conversations per user. 0 means no cap.',
              min: 0,
              step: 1,
              default: 50,
            }),
          ],
        },
      ],
    })
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    const ctx = this.ctx
    const logger = ctx.logger
    const raw = ctx.kernel?.localNodeId ?? ctx.id
    const ownNodeId = raw.includes('/') ? (raw.split('/')[0] ?? raw) : raw
    const isHub = ownNodeId === 'hub'
    const api = ctx.api

    const modelsDir = await this.resolveModelsDir()
    const supervisor = new LlamaSupervisor({ logger: logger.child('llama') })
    this.supervisor = supervisor

    // Only the hub keeps AI state (profiles, usage, chats); an agent runs the
    // llm-runtime alone and carries no records.
    const records = ctx.records
    if (isHub) {
      if (records === undefined) throw new Error('addon-ai needs ctx.records')
      await records.declare(aiRecordKinds)
    }

    const appleLogger = logger.child('apple-fm')
    const appleHelper = new AppleFmHelper({
      binaryPath: appleHelperBinaryPath(),
      logger: appleLogger,
    })
    const appleMirror = new AppleFmAvailabilityMirror({
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      helper: appleHelper,
      logger: appleLogger,
    })
    this.appleHelper = appleHelper
    this.appleMirror = appleMirror

    const binDir = path.join(ctx.nodeDataDir, 'bin')
    const { ensureLlamaServer } = await import('./runtime/ensure-llama-server.js')

    const assembly = await assembleAi({
      nodeId: ownNodeId,
      isHub,
      logger,
      modelsDir,
      ...(records !== undefined ? { records } : {}),
      supervisor,
      ensureBinary: () => ensureLlamaServer({ binDir, logger: logger.child('llama-bin') }),
      ...(isHub && api !== undefined ? { runtimeApi: this.asRuntimeApi(api) } : {}),
      ...(isHub && api !== undefined ? { distributeModel: this.makeDistributeModel(api) } : {}),
      apple: createAppleFmBackend({
        nodeId: ownNodeId,
        helper: appleHelper,
        availability: appleMirror,
        logger: appleLogger,
      }),
    })
    // Off the boot path; a no-op off darwin. Reads never wait on it (D224).
    appleMirror.start(POST_BOOT_DELAY_MS)

    if (isHub) {
      this.schedulePostBoot(assembly)
      await this.serveTestChatPlane(assembly, api)
    }
    return assembly.registrations
  }

  protected async onShutdown(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.length = 0
    await this.testChatPlane?.dispose()
    this.testChatPlane = null
    await this.supervisor?.stop()
    this.appleMirror?.dispose()
    this.appleHelper?.dispose()
  }

  private asRuntimeApi(api: unknown): RuntimeApi {
    // ctx.api (the full tRPC client) satisfies the narrow RuntimeApi slice
    // structurally; the boundary is documented (the api is host-provided).
    return api as RuntimeApi
  }

  private makeDistributeModel(
    api: unknown,
  ): (nodeId: string, model: ManagedModelRef) => Promise<void> {
    const distributor = api as DistributorApi
    return async (nodeId, model) => {
      const resolution = entryForRef(model)
      if (resolution === null) throw new Error('unknown model reference for distribution')
      await distributor.modelDistributor.distributeModel.mutate({
        targetNodeId: nodeId,
        modelId: resolution.entry.id,
        format: 'gguf',
        entry: resolution.entry,
      })
    }
  }

  /**
   * `POST /addon/ai/test-chat` — the admin AI page's streaming test chat.
   *
   * A DATA-PLANE route, not a cap method and not a custom action. It shipped
   * first as `addons.custom` and the operator's first real use failed with
   * `UDS request timed out after 60000ms`: `callAddonOnChild` passes no options
   * and therefore takes `DEFAULT_UDS_REQUEST_TIMEOUT_MS`, with no per-call
   * override on that path. A generation that legitimately takes minutes on a
   * cold GPU load cannot live inside a unary RPC — and the error it produced
   * named the transport rather than the model or the endpoint.
   *
   * HUB ONLY, and that is not a shortcut: the `llm` provider, the profile store
   * and the api keys exist only here, and the facility binds `127.0.0.1`, which
   * the hub could not reach on an agent anyway.
   *
   * `getProfile` reads the store DIRECTLY rather than through `listProfiles`,
   * which redacts the api key — the streamed call needs the real one, and it
   * never leaves this process either way.
   *
   * `getSnapshot` deliberately omits `force`. That flag is an OPERATOR signal
   * that walks past the wrapper's battery-camera sleep gate, and a chat turn is
   * not a reason to wake a camera: a stale-but-honest frame is the right answer
   * and the `meta` event reports how old it is.
   */
  private async serveTestChatPlane(
    assembly: Awaited<ReturnType<typeof assembleAi>>,
    api: AddonApi | undefined,
  ): Promise<void> {
    const store = assembly.store
    const provider = assembly.llmProvider
    const usage = assembly.usage
    if (store === undefined || provider === undefined || usage === undefined || api === undefined) {
      this.ctx.logger.warn('addon-ai: test-chat plane not served — no llm provider on this node')
      return
    }
    const logger = this.ctx.logger.child('llm-test-chat')
    const client = createLlmClient()

    const stream: TestChatStreamDeps = {
      getProfile: (profileId) => store.getById(profileId),
      openStream: (request, opts) =>
        client.openStream(
          {
            profile: request.profile,
            ...(request.system !== undefined ? { system: request.system } : {}),
            prompt: request.prompt,
            ...(request.images !== undefined ? { images: request.images } : {}),
            ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            signal: opts.signal,
          },
          {
            connectTimeoutMs: opts.connectTimeoutMs,
            firstTokenTimeoutMs: opts.firstTokenTimeoutMs,
            onConnected: opts.onConnected,
          },
        ),
      // The fallback for a wire this addon does not stream (anthropic, google,
      // managed-local): one unary call through the provider's own dispatch,
      // which also writes ITS usage row — so the run's own row is suppressed
      // for this path by `recordUsage` below.
      generateOnce: async (request) => {
        const base = {
          profileId: request.profile.id,
          consumer: TEST_CHAT_CONSUMER,
          prompt: request.prompt,
          ...(request.system !== undefined ? { system: request.system } : {}),
          ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        }
        return request.images === undefined || request.images.length === 0
          ? provider.generate(base)
          : provider.generateVision({ ...base, images: [...request.images] })
      },
      getSnapshot: (deviceId) => api.snapshot.getSnapshot.query({ deviceId }),
      getTrackMedia: (
        trackId: string,
        kinds: readonly MediaFileKind[],
        deviceId: number,
      ): Promise<readonly TrackMediaRow[]> =>
        api.pipelineAnalytics.getTrackMedia.query({ trackId, kinds: [...kinds], deviceId }),
      recordUsage: (row) => usage.record(row),
      logger,
      now: () => Date.now(),
    }

    this.testChatPlane =
      (await this.ctx.dataPlane?.serve({
        prefix: TEST_CHAT_PREFIX,
        access: 'authenticated',
        handler: createTestChatPlaneHandler({
          stream,
          logger,
          ...(assembly.chats !== undefined
            ? { chats: assembly.chats, retention: () => this.chatRetention() }
            : {}),
        }),
      })) ?? null

    this.ctx.logger.info('ai test-chat data-plane served', {
      meta: {
        served: this.testChatPlane !== null,
        path: `/addon/${this.ctx.id}/${TEST_CHAT_PREFIX}`,
      },
    })
  }

  private chatRetention(): ChatRetention {
    const days = this.config.chatRetentionMaxAgeDays
    const count = this.config.chatRetentionMaxCount
    return {
      ...(days > 0 ? { maxAgeMs: days * DAY_MS } : {}),
      ...(count > 0 ? { maxCount: count } : {}),
    }
  }

  private schedulePostBoot(assembly: Awaited<ReturnType<typeof assembleAi>>): void {
    const kick = setTimeout(() => {
      void assembly.chats?.pruneAll(this.chatRetention()).catch(() => undefined)
      const interval = setInterval(() => {
        void assembly.chats?.pruneAll(this.chatRetention()).catch(() => undefined)
      }, PRUNE_INTERVAL_MS)
      interval.unref?.()
      void this.autoStartRuntimes(assembly)
    }, POST_BOOT_DELAY_MS)
    kick.unref?.()
    this.timers.push(kick)
  }

  private async autoStartRuntimes(assembly: Awaited<ReturnType<typeof assembleAi>>): Promise<void> {
    const store = assembly.store
    const provider = assembly.llmProvider
    if (store === undefined || provider === undefined) return
    for (const profile of await store.list()) {
      if (!profile.enabled || managedRuntimeOf(profile)?.autoStart !== true) {
        continue
      }
      try {
        await provider.startRuntime({ addonId: profile.addonId, profileId: profile.id })
      } catch (err) {
        this.ctx.logger.warn('addon-ai: autoStart failed', {
          meta: { profileId: profile.id, error: err instanceof Error ? err.message : String(err) },
        })
      }
    }
  }
}

export default AiAddon
