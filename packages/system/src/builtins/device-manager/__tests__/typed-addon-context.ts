/**
 * A TYPED `AddonContext` for specs that initialize a real builtin addon
 * (D648's extension-slot specs), so the spec itself carries no cast.
 *
 * Every member is typed for real except ONE, which is the documented type
 * boundary (CLAUDE.md "Types: no casts … exceptions: a documented type
 * boundary"), in {@link toAddonApi}: `api` is `AddonApi`, the GENERATED tRPC
 * client of every capability (~160 routers, each method a `.query` /
 * `.mutate` proxy). An addon under test calls a handful of them; writing the
 * rest to satisfy the type would be fiction nobody runs. The stub is
 * `ApiStub`: routers the test supplies.
 *
 * `kernel.devices` (the kernel's device factory, which no builtin under test
 * here reaches) is a real `DeviceManagerApi` whose every method refuses by
 * name, the same way `deps` does.
 *
 * A method the addon calls that the stub lacks fails at the call with a
 * TypeError naming it — a missing stub is loud, never a silent default.
 */
import type {
  AddonApi,
  AddonContext,
  AddonInitResult,
  DeviceManagerApi,
  IDeviceExtensionProvider,
  IDeviceManagerProvider,
  IEventBus,
  IKernelServices,
  IScopedLogger,
  ProviderRegistration,
  RecordsAccess,
} from '@camstack/types'

/** Routers the test supplies — `{ deviceManager: { getDevice: { query } } }`. */
export type ApiStub = Readonly<Record<string, unknown>>

/** The kernel members a builtin under test reads (`devices` is always the refusing stub). */
export type KernelStub = Readonly<Omit<Partial<IKernelServices>, 'devices'>>

export interface AddonContextStubOptions {
  readonly id: string
  readonly logger: IScopedLogger
  readonly settings: NonNullable<AddonContext['settings']>
  readonly api: ApiStub
  readonly kernel?: KernelStub
  readonly eventBus?: IEventBus
  /** Hub builtins (device-manager) require `ctx.records` since records phase 6. */
  readonly records?: RecordsAccess
}

/** TYPE BOUNDARY — see the module docblock. */
function toAddonApi(stub: ApiStub): AddonApi {
  return stub as unknown as AddonApi
}

const SILENT_BUS: IEventBus = {
  emit: () => undefined,
  subscribe: () => () => undefined,
  getRecent: () => [],
}

function unavailable(what: string): never {
  throw new Error(`${what} is not available in this test context`)
}

/** The kernel's device factory — every method refuses by name. */
const REFUSING_DEVICES: DeviceManagerApi = {
  create: async () => unavailable('kernel.devices.create'),
  allocateDeviceId: async () => unavailable('kernel.devices.allocateDeviceId'),
  createContext: () => unavailable('kernel.devices.createContext'),
  loadConfig: async () => unavailable('kernel.devices.loadConfig'),
  persistInitialConfig: async () => unavailable('kernel.devices.persistInitialConfig'),
  setName: async () => unavailable('kernel.devices.setName'),
  setLocation: async () => unavailable('kernel.devices.setLocation'),
  setDisabled: async () => unavailable('kernel.devices.setDisabled'),
  register: async () => unavailable('kernel.devices.register'),
  remove: async () => unavailable('kernel.devices.remove'),
  decommission: async () => unavailable('kernel.devices.decommission'),
  applyDerivedSpec: async () => unavailable('kernel.devices.applyDerivedSpec'),
  getAll: async () => unavailable('kernel.devices.getAll'),
  getChildren: async () => unavailable('kernel.devices.getChildren'),
}

export function makeAddonContext(options: AddonContextStubOptions): AddonContext {
  return {
    id: options.id,
    logger: options.logger,
    eventBus: options.eventBus ?? SILENT_BUS,
    addonConfig: {},
    dataDir: '/tmp/camstack-extension-test',
    nodeDataDir: '/tmp/camstack-extension-test',
    kernel: { ...options.kernel, devices: REFUSING_DEVICES },
    settings: options.settings,
    ...(options.records !== undefined ? { records: options.records } : {}),
    api: toAddonApi(options.api),
    deps: {
      ensureBinary: async () => unavailable('deps.ensureBinary'),
      ensureFfmpeg: async () => unavailable('deps.ensureFfmpeg'),
      ensurePython: async () => null,
      installPythonPackages: async () => undefined,
      installPythonRequirements: async () => undefined,
      getDepsDir: () => '/tmp/camstack-extension-test/deps',
    },
    getNativeProvider: () => unavailable('getNativeProvider'),
    fetchDevice: async () => unavailable('fetchDevice'),
    useCapability: () => unavailable('useCapability'),
    acquireCapability: async () => unavailable('acquireCapability'),
    onCapabilityStateChange: () => () => undefined,
    addDisposer: () => () => undefined,
  }
}

// ── Picking a provider off `initialize()`'s answer, cast-free ─────────

function hasMethods(value: unknown, names: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null) return false
  return names.every((name) => typeof Reflect.get(value, name) === 'function')
}

export function isDeviceExtensionProvider(value: unknown): value is IDeviceExtensionProvider {
  return hasMethods(value, ['listSources', 'listSlots', 'listCandidates', 'setSlot'])
}

export function isDeviceManagerProvider(value: unknown): value is IDeviceManagerProvider {
  return hasMethods(value, [
    'allocateDeviceId',
    'registerDevice',
    'setLocation',
    'getLinkedDevices',
  ])
}

/** The registrations an `initialize()` returned, whichever shape it used. */
export function registrationsOf(
  init: readonly ProviderRegistration[] | AddonInitResult | void,
): readonly ProviderRegistration[] {
  if (init === undefined) return []
  if (isRegistrationList(init)) return init
  return init.providers ?? []
}

function isRegistrationList(
  init: readonly ProviderRegistration[] | AddonInitResult,
): init is readonly ProviderRegistration[] {
  return Array.isArray(init)
}

/** The provider registered for `cap`, narrowed by `guard` — throws when absent or mis-shaped. */
export function providerOf<T>(
  regs: readonly ProviderRegistration[],
  cap: string,
  guard: (value: unknown) => value is T,
): T {
  const found = regs.find((r) => r.capability.name === cap)
  if (found === undefined) throw new Error(`no "${cap}" registration`)
  if (!guard(found.provider)) throw new Error(`the "${cap}" registration is not a ${cap} provider`)
  return found.provider
}
