/**
 * `keychain` — hub-only, in-process builtin that owns every secret value
 * (D787). Boots in the infrastructure pass, right after the settings door, so
 * a forked addon's first `resolveConfig` already finds it.
 *
 * Registers two caps from one service:
 *  - `keychain` (internal): the owner's door — put / resolve / delete /
 *    listMeta / getState, owner-checked against the caller the transport
 *    stamped (`callerAddonId`, never in the input schema);
 *  - `keychain-admin`: System → Secrets — status, list, audit, reveal,
 *    orphans, rotation, recovery key, reset (and its report). Every method
 *    admin; those that change or hand out material take the session's user
 *    for the audit.
 *
 * At boot, right after the unlock, the one-shot `<dataDir>/.keychain/RESET_KEYCHAIN`
 * trigger file is honoured (see `keychain-reset-trigger.ts`) — the only way
 * back into a hub whose master key is lost.
 *
 * It does not run on agents: an agent's Phase 1 drops `keychain` from its infra
 * list (`server/backend/src/agent/agent-infra-capabilities.ts`), and an agent
 * addon reaches it through `$hub-cap-fwd` like every other hub cap. Until
 * 2026-10-08 agents DID boot it — their store door forwards to the hub, so an
 * agent wrote the hub's `keychain:keys` row with a key file on its own disk.
 * Booting first, it left the hub locked `key-missing`.
 */
import {
  BaseAddon,
  EventCategory,
  type IKeychainAdminProvider,
  type IKeychainProvider,
  keychainAdminCapability,
  keychainCapability,
  type ProviderRegistration,
} from '@camstack/types'
import { buildKeySourceCandidates, type KeychainKeyConfig } from './key-sources.js'
import { applyKeychainResetTrigger } from './keychain-reset-trigger.js'
import { type KeychainLogger, KeychainService } from './keychain-service.js'
import { keychainRecordKinds } from './record-kinds.js'
import { type KeychainDoor, KeychainRepository } from './keychain-store.js'
import { createKeychainUsageCheck } from './keychain-usage.js'

const DAY_MS = 24 * 60 * 60_000

/** The caller the transport stamped (or an in-process caller stated). */
export function callerOf(input: unknown): string | null {
  if (input === null || typeof input !== 'object') return null
  const raw: unknown = Reflect.get(input, 'callerAddonId')
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

function readKeyConfig(section: Record<string, unknown>): KeychainKeyConfig {
  const keyFile = section['keyFile']
  const previousKeyFile = section['previousKeyFile']
  return {
    keyFile: typeof keyFile === 'string' && keyFile.length > 0 ? keyFile : undefined,
    previousKeyFile:
      typeof previousKeyFile === 'string' && previousKeyFile.length > 0
        ? previousKeyFile
        : undefined,
  }
}

export class KeychainAddon extends BaseAddon {
  readonly id = 'keychain'
  private pruneTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    super({})
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    const ctx = this.ctx
    const store = ctx.api.settingsStore
    const door: KeychainDoor = {
      declareCollection: (input) => store.declareCollection.mutate(input),
      get: (input) => store.get.query(input),
      set: (input) => store.set.mutate(input),
      query: (input) => store.query.query(input),
      delete: (input) => store.delete.mutate(input),
      deleteWhere: (input) => store.deleteWhere.mutate(input),
    }
    const dataDir = ctx.nodeDataDir
    const runnerIdOf = ctx.kernel.runnerIdForAddon ?? ((addonId: string) => addonId)
    const serviceLogger: KeychainLogger = {
      info: (message, meta) => ctx.logger.info(message, meta ? { meta } : undefined),
      warn: (message, meta) => ctx.logger.warn(message, meta ? { meta } : undefined),
      error: (message, meta) => ctx.logger.error(message, meta ? { meta } : undefined),
    }
    const records = ctx.records
    if (records !== undefined) await records.declare(keychainRecordKinds)
    const service = new KeychainService({
      repo: new KeychainRepository(
        door,
        records !== undefined ? KeychainRepository.recordStoresOf(records) : undefined,
      ),
      candidates: async () => {
        // `keychain` is a bootstrap-owned section: config.yaml only (D788).
        const section = (await ctx.settings?.getSection('keychain')) ?? {}
        return buildKeySourceCandidates({ config: readKeyConfig(section), dataDir })
      },
      dataDir,
      events: {
        emit: (payload) => {
          ctx.eventBus.emit({
            id: `keychain-${payload.ref}-${Date.now()}`,
            timestamp: new Date(),
            source: { type: 'addon', id: 'keychain' },
            category: EventCategory.KeychainChanged,
            data: payload,
          })
        },
      },
      logger: serviceLogger,
      runnerIdOf,
      usage: createKeychainUsageCheck(door),
    })
    await service.init()
    // The lost-key way back in: a one-shot file on the host (never an env var).
    await applyKeychainResetTrigger({ service, dataDir, logger: serviceLogger })

    this.pruneTimer = setInterval(() => {
      service.pruneAudit().catch((err: unknown) => {
        ctx.logger.warn('keychain audit prune failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
    }, DAY_MS)
    this.pruneTimer.unref?.()

    const keychain: IKeychainProvider = {
      put: (input) => service.put(callerOf(input), input.ref, input.value),
      resolve: (input) => service.resolve(callerOf(input), input.refs),
      delete: async (input) => ({ deleted: await service.delete(callerOf(input), input.refs) }),
      deleteDeviceScope: async (input) => ({
        refs: await service.deleteDeviceScope(callerOf(input), input.deviceId),
      }),
      releaseRecordRefs: async (input) => ({
        released: await service.releaseRecordRefs(callerOf(input), input.refs, input.onBehalfOf),
      }),
      listMeta: (input) => service.listMeta(callerOf(input)),
      getState: async () => service.getState(),
    }
    const admin: IKeychainAdminProvider = {
      status: () => service.status(),
      listSecrets: () => service.listSecrets(),
      listAudit: (input) => service.listAudit(input.limit ?? 100),
      reveal: (input) => service.reveal(input.caller.userId, input.ref),
      setSystemSecret: (input) =>
        service.setSystemSecret(input.caller.userId, input.name, input.value),
      importSecret: (input) => service.importSecret(input.caller.userId, input.ref, input.value),
      deleteOrphans: (input) => service.deleteOrphans(input.caller.userId, input.refs),
      rotateMasterKey: (input) => service.rotateMasterKey(input.caller.userId),
      purgeRetiredKeys: async (input) => ({
        purged: await service.purgeRetiredKeys(input.caller.userId),
      }),
      downloadRecoveryKey: (input) => service.downloadRecoveryKey(input.caller.userId),
      resetKeychain: (input) => service.resetKeychain(input.caller.userId),
      resetReport: () => service.resetReport(),
      acknowledgeReset: (input) => service.acknowledgeReset(input.caller.userId),
    }
    return [
      { capability: keychainCapability, provider: keychain },
      { capability: keychainAdminCapability, provider: admin },
    ]
  }

  protected async onShutdown(): Promise<void> {
    if (this.pruneTimer !== null) clearInterval(this.pruneTimer)
    this.pruneTimer = null
  }
}

export default KeychainAddon
