/**
 * The device-manager ADDON harness: the real addon over the real sqlite-backed
 * row store, with fake api surfaces (orchestrator switches, per-device
 * reloads, addon restarts, stream-broker forget) and a fake settings door
 * whose rows a migration swaps and a claim writes.
 *
 * Shared by `migrate-device-wiring.spec.ts` (where it was born) and
 * `field-claims-api.spec.ts`: one addon fixture, not a verbatim copy per spec.
 * Style mirrors `device-disabled-events.spec.ts`.
 */
import type {
  DeviceDataEntry,
  DeviceRemovedInput,
  AddonContext,
  AddonStoreRead,
  ClaimOutcome,
  ClaimsListing,
  FieldClaimMode,
  ICapabilityRegistry,
  IDevice,
  IDeviceManagerProvider,
  IEventBus,
  IScopedLogger,
  ProviderRegistration,
  SecretsAccess,
  SystemEvent,
} from '@camstack/types'
import { CAMERA_SWITCH_ORDER, type CameraSwitchId } from '@camstack/types'
import { vi } from 'vitest'
import { DeviceRegistry } from '../../../kernel/device-registry.js'
import { makeRecordsAccessForOwner } from '../../sqlite-storage/__tests__/support/records-world.js'
import { DeviceManagerAddon } from '../device-manager.addon.js'
import { type FakeSettingsStore, makeSettingsStoreApi } from './settings-store-api.js'

let fakeIdSeq = 3800

/**
 * A fake `device-removal-hook` implementer (D865). `data` is what it holds per
 * device; `onDeviceRemoved` deletes the device's entries and counts them.
 */
export interface FakeHook {
  readonly addonId: string
  /** Fail the next N `onDeviceRemoved` calls. */
  failTimes: number
  /** Make `listDeviceData` throw. */
  listFails: boolean
  data: DeviceDataEntry[]
  readonly calls: DeviceRemovedInput[]
}

export function fakeHook(addonId: string, data: readonly DeviceDataEntry[] = []): FakeHook {
  return { addonId, failTimes: 0, listFails: false, data: [...data], calls: [] }
}

export class FakeDevice {
  online = true
  parentDeviceId: number | null = null
  features: readonly string[] = []
  type = 'camera'
  name: string
  readonly id: number
  readonly config = {
    entries: () => [],
    get: () => undefined,
    set: vi.fn(async () => {}),
    setAll: vi.fn(async () => {}),
    onChange: () => () => {},
  }
  constructor(
    readonly stableId: string,
    id?: number,
  ) {
    this.id = id ?? fakeIdSeq++
    this.name = stableId
  }
  removeDevice = vi.fn(async () => {})
}

/** Fake → interface: the one documented type boundary this harness needs. */
export function asDevice(d: FakeDevice): IDevice {
  return d as unknown as IDevice
}

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

/** Flipped by a spec to make the addon store's three-way read answer `failed`. */
export interface Unreadable {
  current: boolean
}

/** The fake settings door: exported so a spec can hand the SAME door to a restarted addon. */
export type HarnessSettings = ReturnType<typeof makeSettings>

export function makeSettings(
  addonStoreUnreadable: Unreadable,
  addonStoreSeed: Record<string, unknown>,
) {
  const addonStore: Record<string, unknown> = { ...addonStoreSeed }
  const deviceStores: Record<number, Record<string, unknown>> = {}
  const runtimeStores: Record<number, Record<string, unknown>> = {}
  const readDeviceStore = vi.fn(async (id: number) => ({ ...deviceStores[id] }))
  return {
    readAddonStore: vi.fn(async () => ({ ...addonStore })),
    // The D651 three-way read the claims index loads from: `failed` while a
    // spec says the store is unreadable, `missing` while nothing was written.
    readAddonStoreResult: vi.fn(async (): Promise<AddonStoreRead> => {
      if (addonStoreUnreadable.current) return { kind: 'failed', error: 'sqlite busy' }
      return Object.keys(addonStore).length > 0
        ? { kind: 'value', value: { ...addonStore } }
        : { kind: 'missing' }
    }),
    writeAddonStore: vi.fn(async (patch: Record<string, unknown>) => {
      Object.assign(addonStore, patch)
    }),
    readDeviceStore,
    readDeviceStoreBatch: vi.fn(
      async (ids: readonly number[]) =>
        new Map(await Promise.all(ids.map(async (id) => [id, await readDeviceStore(id)] as const))),
    ),
    listDeviceStoreIds: vi.fn(async () => Object.keys(deviceStores).map(Number)),
    writeDeviceStore: vi.fn(async (id: number, data: Record<string, unknown>) => {
      deviceStores[id] = { ...data }
    }),
    clearDeviceStore: vi.fn(async (id: number) => {
      delete deviceStores[id]
    }),
    readDeviceRuntimeState: vi.fn(async (id: number) => ({
      ...runtimeStores[id],
    })),
    writeDeviceRuntimeState: vi.fn(async (id: number, data: Record<string, unknown>) => {
      runtimeStores[id] = { ...data }
    }),
    clearDeviceRuntimeState: vi.fn(async (id: number) => {
      delete runtimeStores[id]
    }),
  }
}

export interface SwitchCall {
  readonly deviceId: number
  readonly switchId: string
  readonly enabled: boolean
}

interface ReloadCall {
  readonly addonId: string
  readonly stableId: string
}

export interface SetupOptions {
  /**
   * Addon ids for which the fake capability registry serves a
   * device-provider implementing `reloadDevice`. Omitted entirely ⇒ no
   * registry at all, which is the "provider too old / unreachable" world —
   * every reload fails and the wiring falls back to whole-addon restarts.
   */
  readonly reloadableProviders?: readonly string[]
  /** Boot with the addon store's three-way read answering `failed` (the claims index cannot load). */
  readonly addonStoreUnreadable?: boolean
  /** Keys already on the addon store when the addon boots (a claims index blob, for one). */
  readonly addonStoreSeed?: Record<string, unknown>
  /**
   * A REAL capability registry (and the bus it and the addon share) instead of
   * the fake one above — the end-to-end specs, where the claimed-status overlay
   * the addon installs must be the one every lookup goes through.
   */
  readonly capabilityRegistry?: ICapabilityRegistry
  readonly eventBus?: IEventBus
  readonly localNodeId?: string
  /** The keychain handle the addon's `ctx.secrets` is (D864 removal clean-up). */
  readonly secrets?: SecretsAccess
  /** `device-removal-hook` implementers the fake cluster serves (D865). */
  readonly hooks?: readonly FakeHook[]
  /** Make the provider enumeration itself fail (the registry unreachable). */
  readonly hookListFails?: { current: boolean }
  /** The persisted state of a PREVIOUS addon instance: a restart reads it back. */
  readonly persisted?: {
    readonly settings: HarnessSettings
    readonly settingsStore: FakeSettingsStore
    readonly addonStoreUnreadable: Unreadable
  }
}

/** The `deviceState` cap methods a spec drives on the real provider (D663). */
export interface DeviceStateMethods {
  getCapSlice: (input: {
    deviceId: number
    capName: string
  }) => Promise<Record<string, unknown> | null>
  getNativeCapSlice: (input: {
    deviceId: number
    capName: string
  }) => Promise<Record<string, unknown> | null>
  setCapSlice: (input: {
    deviceId: number
    capName: string
    slice: Record<string, unknown>
  }) => Promise<void>
  claimFields: (input: {
    deviceId: number
    capName: string
    owner: string
    mode: FieldClaimMode
    fields: readonly string[]
    values: Record<string, unknown>
  }) => Promise<ClaimOutcome>
  patchOwnedFields: (input: {
    deviceId: number
    capName: string
    owner: string
    values: Record<string, unknown>
  }) => Promise<ClaimOutcome>
  releaseClaim: (input: {
    deviceId: number
    capName: string
    owner: string
  }) => Promise<ClaimOutcome>
  listClaims: (input: { ownerPrefix?: string }) => Promise<ClaimsListing>
}

export interface Harness {
  readonly provider: IDeviceManagerProvider
  readonly events: SystemEvent[]
  readonly registry: DeviceRegistry
  readonly logger: IScopedLogger
  /** Every switch write that reached the (fake) orchestrator. */
  readonly switchCalls: SwitchCall[]
  /** Every per-device reload that reached a (fake) provider. */
  readonly reloadCalls: ReloadCall[]
  readonly restartedAddonIds: string[]
  /** Interleaved order of switch writes and reloads. */
  readonly timeline: string[]
  /** Peak number of concurrently in-flight `restartAddon` calls. */
  maxConcurrentRestarts: () => number
  /** Make the NEXT orchestrator switch write hang until released. */
  gateNextSwitchWrite: () => { release: () => void; reached: Promise<void> }
  /** The addon's sync owner resolver — reads the hub's `idToAddonId` map. */
  resolveOwner: (deviceId: number) => string | null
  /** The fake settings door — rows the migration swaps. */
  readonly settings: ReturnType<typeof makeSettings>
  /** The sqlite-backed settings store under the device rows — handed to a restarted addon. */
  readonly settingsStore: FakeSettingsStore
  /** The hub mirror as `deviceState.getCapSlice` answers it. */
  capSlice: (deviceId: number, capName: string) => Promise<Record<string, unknown> | null>
  /** Switches the (fake) orchestrator reports OFF for a device before the migration. */
  readonly priorOff: Map<number, readonly CameraSwitchId[]>
  /** The native write path, as a provider's `runtimeState.setCapState` reaches it. */
  setCapSlice: (deviceId: number, capName: string, slice: Record<string, unknown>) => Promise<void>
  /** The `deviceState` provider as registered — claims included. */
  readonly deviceState: DeviceStateMethods
  /** Flip to make the addon store unreadable from now on (the claims index cannot load). */
  readonly addonStoreUnreadable: Unreadable
}

export async function setup(opts: SetupOptions = {}): Promise<Harness> {
  const addon = new DeviceManagerAddon()
  const addonStoreUnreadable: Unreadable = opts.persisted?.addonStoreUnreadable ?? {
    current: opts.addonStoreUnreadable ?? false,
  }
  const settings =
    opts.persisted?.settings ?? makeSettings(addonStoreUnreadable, opts.addonStoreSeed ?? {})
  const events: SystemEvent[] = []
  const bus: IEventBus =
    opts.eventBus ??
    // Fake → interface: the bus has typed `emit`/`subscribe` overloads a plain
    // object literal cannot state. Same boundary the sibling specs use.
    ({
      emit: (event: SystemEvent) => {
        events.push(event)
      },
      subscribe: () => () => {},
      getRecent: () => [],
    } as unknown as IEventBus)
  const registry = new DeviceRegistry()
  const logger = makeLogger()
  const settingsStore = opts.persisted?.settingsStore ?? (await makeSettingsStoreApi())
  const settingsStoreApi = settingsStore.api
  const records = await makeRecordsAccessForOwner('device-manager')

  const switchCalls: SwitchCall[] = []
  const priorOff = new Map<number, readonly CameraSwitchId[]>()
  const reloadCalls: ReloadCall[] = []
  const timeline: string[] = []
  let pendingGate: { release: () => void; reachedResolve: () => void } | null = null

  const restartedAddonIds: string[] = []
  let inFlightRestarts = 0
  let peakRestarts = 0

  // The fake providers the fake capability registry serves. Only
  // `reloadDevice` — that is the one method the migration reaches.
  const providersByAddon = new Map(
    (opts.reloadableProviders ?? []).map((addonId) => [
      addonId,
      {
        reloadDevice: async (input: { stableId: string }) => {
          reloadCalls.push({ addonId, stableId: input.stableId })
          timeline.push(`reload:${addonId}:${input.stableId}`)
          return { deviceId: 0 }
        },
      },
    ]),
  )

  const ctx = {
    api: {
      settingsStore: settingsStoreApi,
      pipelineOrchestrator: {
        // The prior states the migration reads before its disable phase: every
        // switch offered, ON unless `priorOff` names it for that device.
        getCameraSwitches: {
          query: async (input: { deviceId: number }) => ({
            deviceId: input.deviceId,
            fetchedAt: 0,
            switches: CAMERA_SWITCH_ORDER.map((id) => ({
              id,
              available: true,
              enabled: !(priorOff.get(input.deviceId) ?? []).includes(id),
            })),
          }),
        },
        setCameraSwitch: {
          mutate: async (input: SwitchCall) => {
            switchCalls.push(input)
            timeline.push(`switch:${input.deviceId}:${input.switchId}`)
            if (pendingGate !== null) {
              const gate = pendingGate
              pendingGate = null
              gate.reachedResolve()
              await new Promise<void>((resolve) => {
                gate.release = resolve
              })
            }
          },
        },
      },
      streamBroker: {
        forgetDeviceHardware: {
          mutate: async (_input: { deviceId: number }) => {},
        },
      },
      deviceRemovalHook: {
        onDeviceRemoved: {
          mutate: async (input: DeviceRemovedInput & { addonId: string }) => {
            const hook = (opts.hooks ?? []).find((h) => h.addonId === input.addonId)
            if (hook === undefined) throw new Error(`no hook ${input.addonId}`)
            hook.calls.push({
              deviceId: input.deviceId,
              deletedAt: input.deletedAt,
              providerAddonId: input.providerAddonId,
            })
            if (hook.failTimes > 0) {
              hook.failTimes -= 1
              throw new Error('hook unreachable')
            }
            const counts: Record<string, number> = {}
            for (const entry of hook.data.filter((d) => d.deviceId === input.deviceId)) {
              counts[entry.store] = (counts[entry.store] ?? 0) + entry.count
            }
            hook.data = hook.data.filter((d) => d.deviceId !== input.deviceId)
            return { counts }
          },
        },
        listDeviceData: {
          query: async (input: { addonId: string }) => {
            const hook = (opts.hooks ?? []).find((h) => h.addonId === input.addonId)
            if (hook === undefined || hook.listFails) throw new Error('hook unreachable')
            return [...hook.data]
          },
        },
      },
      addons: {
        listCapabilityProviders: {
          query: async (_input: { capName: string }) => {
            if (opts.hookListFails?.current === true) throw new Error('registry unreachable')
            return (opts.hooks ?? []).map((h) => ({ addonId: h.addonId }))
          },
        },
        restartAddon: {
          mutate: async (input: { addonId: string }) => {
            restartedAddonIds.push(input.addonId)
            inFlightRestarts += 1
            peakRestarts = Math.max(peakRestarts, inFlightRestarts)
            await new Promise((resolve) => setTimeout(resolve, 20))
            inFlightRestarts -= 1
          },
        },
      },
    },
    id: 'device-manager',
    logger,
    eventBus: bus,
    addonConfig: {},
    dataDir: '/tmp',
    settings,
    records,
    ...(opts.secrets !== undefined ? { secrets: opts.secrets } : {}),
    kernel: {
      deviceRegistry: registry,
      ...(opts.localNodeId !== undefined ? { localNodeId: opts.localNodeId } : {}),
      ...(opts.capabilityRegistry !== undefined
        ? { capabilityRegistry: opts.capabilityRegistry }
        : opts.reloadableProviders !== undefined
          ? {
              capabilityRegistry: {
                waitForProvider: async (_capName: string, addonId: string) =>
                  providersByAddon.get(addonId) ?? null,
                unregisterAllNativeForDevice: vi.fn(),
                getNativeCapsForDevice: () => [],
                getNativeAddonId: () => null,
                getNativeProvider: () => null,
                // The addon installs the claimed-status overlay at init (D663, S3).
                setStatusOverlay: vi.fn(),
              },
            }
          : {}),
    },
  }
  const initResult = await addon.initialize(ctx as unknown as AddonContext)
  let providers: readonly ProviderRegistration[] | undefined
  if (Array.isArray(initResult)) providers = initResult
  else if (initResult) providers = initResult.providers
  const first = providers?.[0]
  if (!first) throw new Error('no provider registrations')
  const provider = first.provider
  if (!('migrateDevice' in provider)) throw new Error('not the device-manager provider')
  // Fake → interface at the assembled-provider boundary: the object carries
  // `resolveDeviceOwnerSync` beyond the cap surface (see the addon's provider
  // literal); the spec reads it to observe the hub's `idToAddonId` map.
  const withResolver = provider as IDeviceManagerProvider & {
    resolveDeviceOwnerSync: (deviceId: number) => string | null
  }
  const deviceStateProvider = providers?.find((r) => r.capability.name === 'device-state')?.provider
  if (
    !deviceStateProvider ||
    !('getCapSlice' in deviceStateProvider) ||
    !('setCapSlice' in deviceStateProvider) ||
    !('claimFields' in deviceStateProvider)
  ) {
    throw new Error('no device-state provider registration')
  }
  // Same boundary as above: the registration's provider is untyped at the
  // `ProviderRegistration` seam; the spec reads the cap methods off it.
  const deviceState = deviceStateProvider as DeviceStateMethods

  return {
    provider: withResolver,
    events,
    registry,
    logger,
    switchCalls,
    reloadCalls,
    restartedAddonIds,
    timeline,
    maxConcurrentRestarts: () => peakRestarts,
    gateNextSwitchWrite: () => {
      let reachedResolve: () => void = () => {}
      const reached = new Promise<void>((resolve) => {
        reachedResolve = resolve
      })
      const gate = { release: () => {}, reachedResolve }
      pendingGate = gate
      return { release: () => gate.release(), reached }
    },
    resolveOwner: (deviceId) => withResolver.resolveDeviceOwnerSync(deviceId),
    settings,
    settingsStore,
    priorOff,
    capSlice: (deviceId, capName) => deviceState.getCapSlice({ deviceId, capName }),
    setCapSlice: (deviceId, capName, slice) =>
      deviceState.setCapSlice({ deviceId, capName, slice }),
    deviceState,
    addonStoreUnreadable,
  }
}

export async function registerCamera(
  h: Pick<Harness, 'provider' | 'registry'>,
  addonId: string,
  stableId: string,
): Promise<number> {
  const dev = new FakeDevice(stableId)
  h.registry.register(addonId, asDevice(dev))
  await h.provider.allocateDeviceId({ addonId, stableId })
  await h.provider.registerDevice({
    addonId,
    stableId,
    id: dev.id,
    type: 'camera',
    name: stableId,
    parentDeviceId: null,
    config: {},
  })
  return dev.id
}
