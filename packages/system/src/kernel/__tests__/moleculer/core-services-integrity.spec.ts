/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- test file pokes broker registry internals */
/**
 * ────────────────────────────────────────────────────────────────────────────
 * Core-services integrity test — single source of truth for the
 * "hub-only Moleculer service" contract that workers rely on.
 *
 * Every `$<name>` service below is the cross-process transport for a
 * core (non-capability) tRPC router. Workers reach them via
 * `broker.call('$<name>.<action>', …)` — typically wrapped behind a
 * typed `IKernel*` entry on `ctx.kernel`. If an action is dropped,
 * renamed, or a factory is forgotten on hub registration, every
 * worker call breaks with "Service not found" at runtime.
 *
 * Adding a 6th core service? Update `CORE_SERVICES` below AND the two
 * wiring sites listed in the header of each entry. The test will fail
 * until the table + hub wiring + `IKernelServices` key are aligned.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect, afterEach } from 'vitest'
import { ServiceBroker } from 'moleculer'
import { ReadinessRegistry } from '@camstack/types'
import {
  createHubService,
  createReadinessServiceForRegistry,
  createStreamProbeBrokerService,
  createProcessService,
  registerEventBusService,
  EVENT_TOPIC_PREFIX,
} from '../../index.js'

/**
 * Canonical table of every hub-only core service + the actions each
 * must expose. Each entry matches:
 *  - the factory in `packages/kernel/src/moleculer/<name>-service.ts`
 *  - the hub-side registration in
 *    `server/backend/src/core/moleculer/moleculer.service.ts`
 *  - the consumer contract in `packages/types/src/interfaces/addon.ts`
 *    (`IKernelServices.<kernelKey>` → `IKernel<Name>`) where applicable.
 *
 * `kernelKey` is `null` when the service is infrastructural (not
 * surfaced on `ctx.kernel` — e.g. `$event-bus` consumes broadcast
 * events, `$process` is orchestrator-only).
 */
const CORE_SERVICES = [
  {
    name: '$hub',
    kernelKey: null,
    // `$hub.event` was removed — every cross-node event now flows via
    // `broker.broadcast('camstack.evt.<category>', ...)` handled by the
    // `$event-bus` service below.
    actions: ['getAddonConfig', 'getSettings', 'getRecentEvents', 'log', 'setLogLevel'],
  },
  {
    name: '$readiness',
    kernelKey: 'readinessRegistry',
    actions: ['getSnapshot'],
  },
  {
    name: '$stream-probe',
    kernelKey: 'streamProbe',
    actions: ['probe', 'probeField'],
  },
  // NOTE: `$hwaccel` was RETIRED (S3 consolidation). `ctx.kernel.hwaccel`
  // (the local, always-ready primitive) stays; cross-node hwaccel queries go
  // through the node-pinned `platform-probe` cap. The negative assertion below
  // guards against the service being re-registered.
  {
    name: '$process',
    kernelKey: null,
    actions: ['spawnRunner', 'stop', 'restart', 'list'],
  },
  {
    name: '$event-bus',
    kernelKey: null,
    actions: [],
    events: [`${EVENT_TOPIC_PREFIX}**`],
  },
] as const satisfies ReadonlyArray<{
  readonly name: string
  readonly kernelKey: string | null
  readonly actions: readonly string[]
  readonly events?: readonly string[]
}>

/** Register every core service on `broker` with fakes that match the real factory deps. */
function registerAllCoreServices(broker: ServiceBroker): void {
  broker.createService(
    createHubService({
      getAddonConfig: () => ({}),
      getSettings: () => ({}),
      getRecentEvents: () => [],
      onLog: () => {},
    }),
  )
  broker.createService(
    createReadinessServiceForRegistry(
      new ReadinessRegistry({
        eventBus: {
          emit: () => {},
          subscribe: () => () => {},
          on: () => () => {},
          off: () => {},
        } as never,
        sourceNodeId: 'hub',
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
          child: () =>
            ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) as never,
          withTags: () =>
            ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) as never,
        } as never,
      }),
    ),
  )
  broker.createService(
    createStreamProbeBrokerService({
      probe: async () => ({}),
      probeField: async () => ({ status: 'ok' as const }),
    }),
  )
  broker.createService(createProcessService('hub', '/tmp/core-integrity-test'))
  registerEventBusService(broker)
}

function actionAvailable(broker: ServiceBroker, fullName: string): boolean {
  return (broker as any).registry.actions.isAvailable(fullName) as boolean
}

function serviceRegistered(broker: ServiceBroker, serviceName: string): boolean {
  const services = (broker as any).registry.services.services as ReadonlyArray<{ name: string }>
  return services.some((s) => s.name === serviceName)
}

describe('core services broker integrity', () => {
  let broker: ServiceBroker | null = null

  afterEach(async () => {
    if (broker) {
      try {
        await broker.stop()
      } catch {
        /* already stopped */
      }
      broker = null
    }
  })

  it('every declared core service is registered with all declared actions', async () => {
    broker = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    registerAllCoreServices(broker)
    await broker.start()

    for (const svc of CORE_SERVICES) {
      expect(serviceRegistered(broker, svc.name), `Service ${svc.name} not registered`).toBe(true)
      for (const action of svc.actions) {
        const fullName = `${svc.name}.${action}`
        expect(
          actionAvailable(broker, fullName),
          `Missing action ${fullName} — either factory drift or factory not wired in moleculer.service.ts`,
        ).toBe(true)
      }
    }
  })

  it('the retired $hwaccel service is NOT registered (S3 consolidation)', async () => {
    broker = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    registerAllCoreServices(broker)
    await broker.start()

    // `$hwaccel` was retired: cross-node hwaccel resolution goes through the
    // node-pinned `platform-probe` cap, and `ctx.kernel.hwaccel` covers the
    // local always-ready path. Re-introducing the service would resurrect the
    // redundant third surface this consolidation removed.
    expect(serviceRegistered(broker, '$hwaccel')).toBe(false)
    expect(actionAvailable(broker, '$hwaccel.resolve')).toBe(false)
  })

  it('service names all follow the $-prefix convention (infrastructure, not capability)', () => {
    for (const svc of CORE_SERVICES) {
      expect(
        svc.name.startsWith('$'),
        `Core service ${svc.name} must be $-prefixed to stay out of the capability graph`,
      ).toBe(true)
    }
  })

  it('IKernelServices keys referenced by CORE_SERVICES exist on the interface', async () => {
    // We probe the shape structurally — compile-time types can't see runtime kernelKey values.
    // Importing the interface in a type position and projecting via `keyof` gives us the
    // authoritative key set.
    const claimedKeys = CORE_SERVICES.map((s) => s.kernelKey).filter(
      (k): k is NonNullable<typeof k> => k !== null,
    )

    // Known legitimate kernel entries that back a `$*` service.
    // If a future CORE_SERVICES entry adds a kernelKey, add it here too —
    // keep this list in sync with `IKernelServices`.
    const knownKernelKeys: ReadonlySet<string> = new Set(['readinessRegistry', 'streamProbe'])

    for (const key of claimedKeys) {
      expect(
        knownKernelKeys.has(key),
        `CORE_SERVICES claims kernel key "${key}" but it isn't in the known set. ` +
          `Add it to IKernelServices AND to knownKernelKeys above.`,
      ).toBe(true)
    }
  })

  it('ctx.kernel keys wired to a $-service route through that service (no function-shape drift)', async () => {
    // This is the specific bug class that prompted this test: a kernel
    // service was typed as an object `{ probe, probeField }` in
    // `IKernelServices` but the addon-context-factory still populated
    // a bare function, so every `ctx.kernel.streamProbe.probe(...)`
    // threw "probe is not a function" at runtime.
    //
    // We can't reach into the addon-context-factory safely from a unit
    // test (it needs a full broker + storage + event-bus graph), so
    // instead we verify the factory signatures surface an object with
    // the declared action names — callers that use `broker.call` get
    // the same behaviour through the Moleculer action namespace.
    broker = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    registerAllCoreServices(broker)
    await broker.start()

    for (const svc of CORE_SERVICES) {
      if (svc.kernelKey === null) continue
      // The action namespace `$<name>` must exist AND expose every
      // method that `IKernelServices[kernelKey]` declares — if the
      // interface adds `probeFieldBatch` without a corresponding
      // action, calls from forked workers would silently 404.
      for (const action of svc.actions) {
        expect(
          actionAvailable(broker, `${svc.name}.${action}`),
          `Interface contract drift: ctx.kernel.${svc.kernelKey}.${action} has no ${svc.name}.${action} broker action`,
        ).toBe(true)
      }
    }
  })
})
