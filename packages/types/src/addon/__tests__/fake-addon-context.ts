/**
 * A fully TYPED `AddonContext` for `BaseAddon` unit tests — no cast.
 *
 * Every member a test does not name is a stub that throws when touched, so a
 * `BaseAddon` path that reaches for a service the test did not wire fails by
 * name instead of reading `undefined`. `ctx.api` is a real tRPC client whose
 * only link throws: the generated `AddonApi` type is satisfied without an
 * `as`, and any call names itself in the error.
 */
import { createTRPCClient, type TRPCLink } from '@trpc/client'
import type { AppRouter } from '../../generated/addon-api.js'
import type { AddonContext } from '../../interfaces/addon.js'

type SettingsView = NonNullable<AddonContext['settings']>

/** The settings members a test usually wires; the rest throw by name. */
export interface FakeSettings {
  readonly readAddonStore?: SettingsView['readAddonStore']
  readonly readAddonStoreResult?: NonNullable<SettingsView['readAddonStoreResult']>
}

export interface FakeAddonContextOptions {
  readonly id?: string
  readonly localNodeId?: string
  readonly settings?: FakeSettings
}

function unused(name: string): () => never {
  return () => {
    throw new Error(`${name} is not part of this test`)
  }
}

const unwiredLink: TRPCLink<AppRouter> = () => () => {
  throw new Error('ctx.api is not wired in this test')
}

function fakeLogger(): AddonContext['logger'] {
  const logger: AddonContext['logger'] = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function fakeDevices(): AddonContext['kernel']['devices'] {
  return {
    create: unused('kernel.devices.create'),
    allocateDeviceId: unused('kernel.devices.allocateDeviceId'),
    createContext: unused('kernel.devices.createContext'),
    loadConfig: unused('kernel.devices.loadConfig'),
    persistInitialConfig: unused('kernel.devices.persistInitialConfig'),
    setName: unused('kernel.devices.setName'),
    setLocation: unused('kernel.devices.setLocation'),
    setDisabled: unused('kernel.devices.setDisabled'),
    register: unused('kernel.devices.register'),
    remove: unused('kernel.devices.remove'),
    decommission: unused('kernel.devices.decommission'),
    applyDerivedSpec: unused('kernel.devices.applyDerivedSpec'),
    getAll: unused('kernel.devices.getAll'),
    getChildren: unused('kernel.devices.getChildren'),
  }
}

function fakeSettings(overrides: FakeSettings): SettingsView {
  const readAddonStoreResult = overrides.readAddonStoreResult
  return {
    readAddonStore: overrides.readAddonStore ?? (async () => ({})),
    // Left out entirely when not wired: the optional member's ABSENCE is what
    // `readStoredGlobalKey` reads as `three-way-read-unavailable`.
    ...(readAddonStoreResult !== undefined ? { readAddonStoreResult } : {}),
    writeAddonStore: unused('settings.writeAddonStore'),
    readDeviceStoreBatch: unused('settings.readDeviceStoreBatch'),
    listDeviceStoreIds: unused('settings.listDeviceStoreIds'),
    readDeviceStore: unused('settings.readDeviceStore'),
    writeDeviceStore: unused('settings.writeDeviceStore'),
    clearDeviceStore: unused('settings.clearDeviceStore'),
    getSection: unused('settings.getSection'),
    setSection: unused('settings.setSection'),
    readDeviceRuntimeState: unused('settings.readDeviceRuntimeState'),
    writeDeviceRuntimeState: unused('settings.writeDeviceRuntimeState'),
    clearDeviceRuntimeState: unused('settings.clearDeviceRuntimeState'),
  }
}

export function fakeAddonContext(options: FakeAddonContextOptions = {}): AddonContext {
  return {
    id: options.id ?? 'test-addon',
    logger: fakeLogger(),
    eventBus: {
      emit: () => undefined,
      subscribe: () => () => undefined,
      getRecent: () => [],
    },
    addonConfig: {},
    dataDir: '/nonexistent/test-addon',
    nodeDataDir: '/nonexistent',
    kernel: { localNodeId: options.localNodeId ?? 'hub', devices: fakeDevices() },
    settings: fakeSettings(options.settings ?? {}),
    api: createTRPCClient<AppRouter>({ links: [unwiredLink] }),
    deps: {
      ensureBinary: unused('deps.ensureBinary'),
      ensureFfmpeg: unused('deps.ensureFfmpeg'),
      ensurePython: unused('deps.ensurePython'),
      installPythonPackages: unused('deps.installPythonPackages'),
      installPythonRequirements: unused('deps.installPythonRequirements'),
      getDepsDir: unused('deps.getDepsDir'),
    },
    getNativeProvider: unused('getNativeProvider'),
    fetchDevice: unused('fetchDevice'),
    useCapability: unused('useCapability'),
    acquireCapability: unused('acquireCapability'),
    onCapabilityStateChange: unused('onCapabilityStateChange'),
    addDisposer: () => () => undefined,
  }
}
