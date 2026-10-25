import { ReplEngine } from '@camstack/system'
import type { IReplContextProvider } from '@camstack/system'
import { SystemMirror, type SystemMirrorApi, type DeviceProxy } from '@camstack/types'
import { AddonRegistryService } from '../addon/addon-registry.service'
import { EventBusService } from '../events/event-bus.service'
import { LoggingService } from '../logging/logging.service'

export class ReplEngineService extends ReplEngine {
  /**
   * Lazily-instantiated `SystemMirror` shared across REPL sessions.
   * Holds a single warm-boot mirror that every `sm.getDeviceById(id)`
   * lookup serves from. Init runs at first access (Promise cached so
   * concurrent sessions don't double-fetch).
   */
  private static systemMirror: SystemMirror | null = null
  private static systemMirrorInit: Promise<SystemMirror> | null = null

  /**
   * Build a `SystemMirrorApi` for in-process server use. The cap-method
   * surface (deviceManager / deviceState queries) goes through the
   * standard broker tRPC client — those resolve locally via
   * `localProviderLink`. The `live.onEvent` channel is NOT a cap, so
   * the broker can't route it; we synthesize the same shape over the
   * local `EventBusService` so SystemMirror subscriptions work without
   * crossing the network boundary or polling the broker for a
   * non-existent `live` service.
   */
  private static buildInProcessApi(
    addonRegistry: AddonRegistryService,
    eventBus: EventBusService,
  ): SystemMirrorApi {
    const baseApi = addonRegistry.getBrokerApi() as SystemMirrorApi
    return {
      ...baseApi,
      live: {
        onEvent: {
          subscribe: (input, opts) => {
            const off = eventBus.subscribe({ category: input.category }, (evt) => {
              try {
                opts.onData({ data: evt.data })
              } catch (err) {
                opts.onError?.(err)
              }
            })
            return { unsubscribe: off }
          },
        },
      },
    }
  }

  private static getOrInitSystemMirror(
    addonRegistry: AddonRegistryService,
    eventBus: EventBusService,
  ): Promise<SystemMirror> {
    if (this.systemMirror) return Promise.resolve(this.systemMirror)
    if (!this.systemMirrorInit) {
      const api = this.buildInProcessApi(addonRegistry, eventBus)
      const sm = new SystemMirror(api)
      this.systemMirrorInit = sm.init().then(() => {
        this.systemMirror = sm
        return sm
      })
    }
    return this.systemMirrorInit
  }

  constructor(
    addonRegistry: AddonRegistryService,
    eventBus: EventBusService,
    _loggingService: LoggingService,
  ) {
    const contextProvider: IReplContextProvider = {
      async getSystemSandbox() {
        const integrationRegistry = addonRegistry.getIntegrationRegistry()
        const deviceRegistry = addonRegistry.getDeviceRegistry()
        // Warm-boot the SystemMirror so `sm.getDeviceById(id)` is sync
        // for the first user expression.
        const sm = await ReplEngineService.getOrInitSystemMirror(addonRegistry, eventBus)
        return {
          // ── New canonical API ───────────────────────────────────────
          /**
           * SystemMirror — the cap-driven, reactive view of every
           * device. Sync `getDeviceById(id)`, typed `state.<cap>.value`
           * reads, full method dispatch, query helpers.
           */
          sm,
          // ── Legacy (kept for backward-compat) ──────────────────────
          addonRegistry,
          eventBus,
          integrationRegistry,
          devices: () => deviceRegistry.getAll(),
          integrations: async () => (await integrationRegistry?.listIntegrations()) ?? [],
          addons: () => addonRegistry.listAddons(),
          getDevice: (id: number) => deviceRegistry.getById(id),
          getIntegration: async (id: string) =>
            (await integrationRegistry?.getIntegration(id)) ?? null,
          getSystemMirror: () => Promise.resolve(sm),
        }
      },
      async getDeviceSandbox(deviceId: number) {
        const deviceRegistry = addonRegistry.getDeviceRegistry()
        const rawDevice = deviceRegistry.getById(deviceId)
        const sm = await ReplEngineService.getOrInitSystemMirror(addonRegistry, eventBus)
        // `device` is the typed DeviceProxy backed by the SystemMirror
        // mirror — same shape as `sm.getDeviceById(deviceId)`. Sync
        // state reads + cap-method dispatch via the wrapper chain.
        const device: DeviceProxy | null = sm.getDeviceById(deviceId)
        return {
          /** SystemMirror — full cluster view. */
          sm,
          /**
           * The current device as a DeviceProxy. Sync state reads
           * (`device.state.battery.value`) + async cap methods
           * (`await device.snapshot.getSnapshot({})`).
           */
          device,
          /** Numeric device id (same as URL). */
          deviceId,
          /** Device metadata (name, addonId, type, online, …). */
          info: sm.getDeviceInfo(deviceId),
          /** Raw IDevice instance — escape hatch for legacy access.
           *  Prefer `device` (DeviceProxy) for new code. */
          rawDevice,
        }
      },
      getProviderSandbox(addonId: string) {
        const integrationRegistry = addonRegistry.getIntegrationRegistry()
        const deviceRegistry = addonRegistry.getDeviceRegistry()
        const devices = deviceRegistry.getAllForAddon(addonId)
        return {
          getIntegration: () =>
            integrationRegistry?.getIntegration(addonId) ?? Promise.resolve(null),
          devices,
        }
      },
      getAddonSandbox(addonId: string) {
        // REPL exposes addon metadata only — never the live in-process
        // instance. Direct addon access only works for hub-local addons
        // and breaks for remote-agent addons. To invoke addon behaviour
        // from the REPL, use the cap router via tRPC instead.
        const entry = addonRegistry.listAddons().find((e) => e.manifest.id === addonId)
        return {
          manifest: entry?.manifest,
          declaration: entry?.declaration,
          source: entry?.source,
          installSource: entry?.installSource,
          process: entry?.process,
        }
      },
    }

    super(contextProvider)
  }
}
