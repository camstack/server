import { userError } from '@camstack/types'
import {
  ReolinkBaichuanApi,
  type ReolinkEvent,
  type ReolinkSimpleEvent,
} from '@apocaliss92/nodelink-js'
import { createMotionSensorTracker } from './motion-sensor-source.js'
import {
  buildDeviceAdminUrl,
  deviceAdminLinkCapability,
  BaseDevice,
  DeviceFeature,
  DeviceType,
  EventCategory,
  hydrateSchema,
  type ConfigUISchema,
  type ConfigUISchemaWithValues,
  type DeviceContext,
  type InferNativeProvider,
  type IDevice,
  deviceDiscoveryCapability,
  rebootCapability,
  type DeviceDiscoveryStatus,
  type DiscoveredChildDevice,
  type DiscoveredChildStatus,
  type RawStateResult,
} from '@camstack/types'
import { buildRawState } from './raw-state.js'

import { reolinkHubSchema, ReolinkSocketDebugFlagSchema } from './schema.js'
import type { ReolinkSocketDebugFlag } from './schema.js'
import { ReolinkCamera, type ReolinkHubLike } from './reolink-camera.js'
import { planChannelReconciliation } from './hub-channel-reconcile.js'
import {
  asDebugSocketFlags,
  shouldTraceSimpleEventDispatch,
} from './simple-event-dispatch-trace.js'
import { populateReolinkMetadata } from './metadata-populator.js'
import { mapHubBatteryPower, UnmappedCodeLedger } from './hub-battery-fields.js'
import {
  captureSessionsSnapshot,
  buildSessionsTabSections,
  SESSIONS_SNAPSHOT_MAX_AGE_MS,
  type SessionsSnapshot,
} from './sessions-snapshot.js'

const HUB_DISCOVERY_REFRESH_TIMEOUT_MS = 8000
/**
 * How often the hub re-reads its own channels summary to reconcile the
 * adopted children's sleep slices. 60 s: a naturally-waking camera (PIR,
 * schedule) is caught within a minute, and the play path has its own
 * faster confirm + post-dial watch, so this only ever carries background
 * drift. Never wakes a child — the summary is answered by the hub itself.
 */
const HUB_CHILD_SLEEP_RECONCILE_MS = 60_000
const HUB_RECONNECT_BASE_MS = 2000
const HUB_RECONNECT_MAX_MS = 30_000

/**
 * Reolink Hub / NVR — single Baichuan socket fronting N channels.
 *
 * The NVR pattern:
 *   - One persistent control + event socket on the parent (no
 *     per-channel login).
 *   - `device-discovery` cap exposes the channel list with status,
 *     plus adopt / release for promoting a channel to a real child
 *     `ReolinkCamera`.
 *   - Every `simpleEvent` from any channel is dispatched into the
 *     matching child's handler via the channel→deviceId map.
 *
 * Streaming + per-channel settings are NOT owned by this class — each
 * adopted child is a full `ReolinkCamera` with its own runtime-state
 * slices. The hub deliberately does not register `snapshot`, `motion`,
 * `intercom`, `ptz` etc. on itself: a Hub is not a camera, and the UI
 * shouldn't surface streaming affordances on the parent.
 *
 * Battery channels under a Hub: the child `ReolinkCamera` may proxy
 * status reads through the Hub's already-warm socket so a "is the cam
 * online" UI poll doesn't need to wake the cam. The pattern lives in
 * `ReolinkCamera`; the Hub just provides `getApi()` to children that
 * ask for it via `parentHub`.
 */
export class ReolinkHub extends BaseDevice<typeof reolinkHubSchema> implements ReolinkHubLike {
  readonly features: readonly DeviceFeature[] = [DeviceFeature.Rebootable]

  /** Long-lived control + event socket. Lazily built; one per Hub. */
  private api: ReolinkBaichuanApi | null = null
  private connectInFlight: Promise<ReolinkBaichuanApi> | null = null
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** Periodic child-sleep reconcile timer (armed in `onActivate`). */
  private sleepReconcileTimer: ReturnType<typeof setInterval> | null = null
  private shutdownRequested = false

  /** Diagnostic Sessions snapshot — same shape as the camera's. */
  private sessionsSnapshot: SessionsSnapshot | null = null
  private sessionsRefreshInFlight: Promise<void> | null = null

  /**
   * Map from camera-side channel index → kernel device id of the
   * adopted child. Drives `onSimpleEvent` dispatch (fast lookup on
   * the hot event path). Rebuilt on every adopt / release / discovery
   * refresh; the kernel registry remains the canonical truth (the
   * `parentDeviceId` filter on `DeviceRegistered`/`DeviceUnregistered`
   * keeps the slice + map in sync after every change).
   */
  private channelToDeviceId = new Map<number, number>()
  /** One-shot: the raw per-channel battery payload is logged once per
   *  process so the firmware's charge-field naming is on record. */
  private batteryShapeLogged = false
  /** Firmware power codes this hub could not translate — warned once each. */
  private readonly unmappedBatteryCodes = new UnmappedCodeLedger()
  /** Channels the last successful discovery refresh listed as present but
   *  NOT adopted — their pushes are expected drops (debug), not faults. */
  private readonly knownUnadoptedChannels = new Set<number>()

  /** Wall-clock ms of the last discovery refresh that included this
   *  child's channel. Drives the offline marker — a child that hasn't
   *  appeared in the firmware's channel list for `MISSING_OFFLINE_MS`
   *  gets `markOnline(false)`. Re-appearance (next refresh seeing the
   *  channel) restores `markOnline(true)`. */
  private childLastSeenAt = new Map<number, number>()

  /** Threshold for marking an adopted child offline when missing from
   *  consecutive discovery refreshes. 10 minutes covers ~3 default
   *  refresh cycles + transient firmware latency without false-flagging
   *  battery cams that take a few cycles to wake into discovery. */
  private static readonly MISSING_OFFLINE_MS = 10 * 60_000

  /** Bound listener so off-then-on is idempotent across reconnects. */
  private readonly handleSimpleEventBound = (ev: ReolinkSimpleEvent): void => {
    this.routeSimpleEvent(ev)
  }

  /** MD vs PIR per channel, read off the raw client event the lib's simple
   *  event drops (`motion-sensor-source.ts`) and handed to the child. */
  private readonly motionSensors = createMotionSensorTracker()
  private readonly observeRawEventBound = (ev: ReolinkEvent): void => {
    this.motionSensors.observe(ev)
  }

  /** Off-then-prepend: recorded before the API maps the same emit. */
  private observeMotionSensors(api: ReolinkBaichuanApi): void {
    api.client.off('event', this.observeRawEventBound)
    api.client.prependListener('event', this.observeRawEventBound)
  }

  constructor(ctx: DeviceContext) {
    super(ctx, reolinkHubSchema, { type: DeviceType.Hub })
    this.registerDeviceDiscovery()
    this.registerReboot()
  }

  /**
   * Hub-level reboot via Baichuan cmd_id 23. Identical wire shape to
   * the per-camera path on `ReolinkCamera`, but the Hub passes
   * `channel = undefined` so the firmware reboots the host (not a
   * sub-channel). The lib's `api.reboot()` accepts the unset arg.
   *
   * The cap is mounted unconditionally because every Reolink Hub /
   * NVR firmware we support exposes cmd 23. `features` already
   * advertises `Rebootable` so the UI shows the button regardless.
   * Without this registration the cap router's `requireDeviceScoped`
   * lookup throws "Capability 'reboot' not registered for device N"
   * and the operator click silently fails.
   */
  /**
   * Return the Hub's RAW upstream state as a display-safe
   * `{ source:'reolink', data }` blob built from the CACHED runtime-state
   * slices (e.g. `device-discovery`, `device-status`) — no socket
   * round-trip. Credential-bearing fields are redacted. `null` when no
   * slice has been written yet.
   */
  async getRawState(): Promise<RawStateResult | null> {
    return buildRawState(this.runtimeState)
  }

  private registerReboot(): void {
    const provider: InferNativeProvider<typeof rebootCapability> = {
      reboot: async ({ deviceId }) => {
        if (deviceId !== this.id) {
          throw new Error(`ReolinkHub: deviceId mismatch, expected ${this.id}, got ${deviceId}`)
        }
        const api = await this.ensureApi()
        await api.reboot()
        return { success: true as const }
      },
    }
    this.ctx.registerNativeCap(rebootCapability, provider)

    // device-admin-link — the NVR/Hub's own web console. Same Baichuan-port
    // caveat as the camera: `config.port` is 9000, the web UI is on 80.
    const adminLinkProvider: InferNativeProvider<typeof deviceAdminLinkCapability> = {
      getAdminLink: async ({ deviceId }) => {
        if (deviceId !== this.id) {
          throw new Error(`ReolinkHub: deviceId mismatch, expected ${this.id}, got ${deviceId}`)
        }
        const host = this.config.get('host') ?? ''
        const built = buildDeviceAdminUrl({ host, port: null, scheme: 'http', path: '/' })
        if (!built.ok) {
          this.ctx.logger.debug('reolink hub admin link unavailable', {
            tags: { deviceId: this.id },
            meta: { reason: built.reason },
          })
          return null
        }
        return { url: built.url, label: 'Web UI', target: 'device' as const, host }
      },
    }
    this.ctx.registerNativeCap(deviceAdminLinkCapability, adminLinkProvider)
  }

  override async onActivate(): Promise<void> {
    // Best-effort first dial. Any failure is logged and retried via
    // the reconnect loop — discovery callers will block on
    // `ensureApi()` until the first connect completes.
    void this.ensureApi().catch((err) => {
      this.ctx.logger.warn('Reolink Hub initial connect failed — will retry', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    })

    // Listen for EXTERNAL child unregistration so a manual delete
    // (operator removed a child via the device-manager UI, restore
    // pruned a stale row, …) flips the panel's `alreadyAdopted` flag
    // without waiting for the 10s poll.
    //
    // We deliberately do NOT listen on `DeviceRegistered`:
    //   - `adoptDiscoveredChild` fires its own `await refreshDiscoveryFromCamera()`
    //     after `kernel.devices.create` returns, so the mutation's
    //     post-success state is already fresh by the time the UI
    //     invalidates.
    //   - listening to `DeviceRegistered` would double-fire the
    //     refresh: once on the first `registerDevice` from the kernel's
    //     Phase 2, then again from the explicit refresh in adopt.
    //   - external adopts (someone calling `kernel.devices.create`
    //     without going through `hub.adoptDevice`) are extremely rare
    //     and the next 10s poll will catch them.
    //
    // A child REGISTERING re-seeds its routing-map entry. The boot race this
    // closes (live hub, 2026-08-15): the connect-time discovery refresh reads
    // the registry BEFORE the two-pass restore has rebuilt the adopted
    // children, so the map stayed empty for the process's life and
    // `routeSimpleEvent` silently dropped every awake/sleeping/battery push
    // for those channels — a hub child could never be seen to wake or sleep
    // again. This is NOT the double-fire the no-DeviceRegistered rule exists
    // to avoid: we merge one map entry from the registry fact, we do not
    // re-run the CGI discovery the adopt path already runs.
    this.eventUnsubscribers.push(
      this.ctx.eventBus.subscribe({ category: EventCategory.DeviceRegistered }, (event) => {
        const data = event.data as {
          deviceId?: number
          parentDeviceId?: number | null
        }
        if (data.parentDeviceId !== this.id) return
        void (async () => {
          const byChannel = await this.loadAdoptedChildrenByChannel()
          for (const [ch, did] of byChannel) this.channelToDeviceId.set(ch, did)
        })().catch(() => {
          /* best-effort — the next refresh re-reads the registry anyway */
        })
      }),
    )

    // Filter by `parentDeviceId` from the event payload — only events
    // about OUR children trigger a refresh.
    this.eventUnsubscribers.push(
      this.ctx.eventBus.subscribe({ category: EventCategory.DeviceUnregistered }, (event) => {
        const data = event.data as {
          deviceId?: number
          parentDeviceId?: number | null
        }
        if (data.parentDeviceId !== this.id) return
        const cid = typeof data.deviceId === 'number' ? data.deviceId : null
        // The routing map is merge-only now (see `refreshDiscoveryFromCamera`),
        // so an EXTERNAL removal is the one thing that must delete from it
        // explicitly — otherwise a released channel keeps routing pushes into
        // a freed device id forever. This event IS the fact; the registry
        // going quiet is not.
        if (cid !== null) {
          for (const [ch, did] of this.channelToDeviceId.entries()) {
            if (did === cid) this.channelToDeviceId.delete(ch)
          }
        }
        this.ctx.logger.info(
          'Reolink Hub: child unregistered externally — refreshing discovery',
          cid !== null ? { tags: { deviceId: cid } } : {},
        )
        void this.refreshDiscoveryFromCamera().catch(() => {
          /* best-effort */
        })
      }),
    )

    // Periodic child-sleep reconcile (the backstop). The push channel is the
    // fast path, but hub children have no own sleep poll and a missed push
    // used to freeze a child's `sleeping` slice for the process's life
    // (2026-08-15: porta retro "awake" for hours while asleep; laundry the
    // reverse mid-wake). The channels summary is the hub's OWN mains-powered
    // read — it never touches a battery camera, so polling it is free.
    this.sleepReconcileTimer = setInterval(() => {
      void this.refreshDiscoveryFromCamera().catch(() => {
        /* best-effort — the next tick retries */
      })
    }, HUB_CHILD_SLEEP_RECONCILE_MS)
    if (typeof this.sleepReconcileTimer.unref === 'function') this.sleepReconcileTimer.unref()
  }

  private eventUnsubscribers: Array<() => void> = []

  /** Per-channel throttle for the unrouted-event warning (see
   *  `routeSimpleEvent`) — a chatty unmapped channel must not flood. */
  private readonly unroutedChannelLoggedAt = new Map<number, number>()

  override async removeDevice(): Promise<void> {
    this.shutdownRequested = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.sleepReconcileTimer) {
      clearInterval(this.sleepReconcileTimer)
      this.sleepReconcileTimer = null
    }
    for (const unsub of this.eventUnsubscribers) {
      try {
        unsub()
      } catch {
        /* best-effort */
      }
    }
    this.eventUnsubscribers = []
    if (this.api) {
      try {
        await this.api.close({ reason: 'hub-shutdown' })
      } catch {
        /* best-effort */
      }
      this.api = null
    }
  }

  // ── Settings UI ──────────────────────────────────────────────────────

  /**
   * Hub-specific settings form:
   * connection (host / port / credentials) on the General tab,
   * Baichuan debug flags on Advanced. Per-channel settings (image,
   * motion, AI sensitivity, …) live on the adopted child cameras —
   * the Hub is purely a connection + discovery surface.
   */
  override getSettingsUISchema(): ConfigUISchemaWithValues {
    const cache = this.config.get('deviceCache')
    // Kick off the Sessions snapshot refresh if stale — non-blocking,
    // results land on the next aggregate poll.
    const snap = this.sessionsSnapshot
    const isStale = snap === null || Date.now() - snap.ts > SESSIONS_SNAPSHOT_MAX_AGE_MS
    if (isStale) {
      void this.refreshSessionsSnapshot().catch((err) => {
        this.ctx.logger.debug('Hub sessions refresh threw', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
    }
    const schema: ConfigUISchema = {
      tabs: [
        { id: 'general', label: 'General', icon: 'settings', order: 0 },
        { id: 'sessions', label: 'Sessions', icon: 'users', order: 80 },
      ],
      sections: [
        ...buildSessionsTabSections(snap, {
          tabId: 'sessions',
          title: 'Hub Sessions',
          autoRefreshes: true,
        }),
        {
          id: 'connection',
          tab: 'general',
          title: 'Connection',
          titleKey: 'provider-reolink:hub.s_connection.title',
          description: 'Child cameras inherit these credentials.',
          descriptionKey: 'provider-reolink:hub.s_connection.description',
          columns: 2,
          fields: [
            {
              type: 'text',
              key: 'host',
              label: 'Hub IP',
              labelKey: 'provider-reolink:hub.s_connection.host.label',
              required: true,
              placeholder: '192.168.10.100',
            },
            {
              type: 'number',
              key: 'port',
              label: 'Port',
              labelKey: 'provider-reolink:hub.s_connection.port.label',
              default: 9000,
              min: 1,
              max: 65535,
              step: 1,
            },
            {
              type: 'text',
              key: 'username',
              label: 'Username',
              labelKey: 'provider-reolink:hub.s_connection.username.label',
              default: 'admin',
            },
            {
              type: 'password',
              key: 'password',
              label: 'Password',
              labelKey: 'provider-reolink:hub.s_connection.password.label',
              required: true,
              showToggle: true,
            },
          ],
        },
        {
          id: 'identity',
          tab: 'general',
          title: 'Hub identity',
          titleKey: 'provider-reolink:hub.s_identity.title',
          columns: 2,
          fields: [
            {
              type: 'text',
              key: '_model',
              label: 'Model',
              labelKey: 'provider-reolink:hub.s_identity._model.label',
              default: cache?.model ?? 'unknown',
              disabled: true,
            },
            {
              type: 'text',
              key: '_channelCount',
              label: 'Total channels',
              labelKey: 'provider-reolink:hub.s_identity._channelCount.label',
              default: String(cache?.channelCount ?? 0),
              disabled: true,
            },
          ],
        },
        {
          id: 'debug',
          tab: 'advanced',
          title: 'Debug',
          titleKey: 'provider-reolink:hub.s_debug.title',
          description: 'Debug logging adds log volume; use it temporarily.',
          descriptionKey: 'provider-reolink:hub.s_debug.description',
          columns: 1,
          fields: [
            {
              type: 'boolean',
              key: 'debugGeneral',
              label: 'General debug logs',
              labelKey: 'provider-reolink:hub.s_debug.debugGeneral.label',
              default: false,
              style: 'switch',
            },
            {
              type: 'multiselect',
              key: 'debugSocketLogs',
              label: 'Socket trace categories',
              labelKey: 'provider-reolink:hub.s_debug.debugSocketLogs.label',
              description: 'Each area adds log volume.',
              descriptionKey: 'provider-reolink:hub.s_debug.debugSocketLogs.description',
              default: [],
              options: [
                {
                  value: 'debugRtsp',
                  label: 'RTSP (proxy/server traffic)',
                  labelKey: 'provider-reolink:hub.s_debug.debugSocketLogs.o_debugRtsp.label',
                },
                {
                  value: 'traceNativeStream',
                  label: 'Native stream (cmd 3/4 + H.264/H.265 + param sets)',
                  labelKey:
                    'provider-reolink:hub.s_debug.debugSocketLogs.o_traceNativeStream.label',
                },
                {
                  value: 'traceRecordings',
                  label: 'Recordings (FileInfoList, findAlarmVideo, download)',
                  labelKey: 'provider-reolink:hub.s_debug.debugSocketLogs.o_traceRecordings.label',
                },
                {
                  value: 'traceTalk',
                  label: 'Talkback (cmd 10/11/201/202)',
                  labelKey: 'provider-reolink:hub.s_debug.debugSocketLogs.o_traceTalk.label',
                },
                {
                  value: 'traceEvents',
                  label: 'Events (cmd 33 — AlarmEventList push)',
                  labelKey: 'provider-reolink:hub.s_debug.debugSocketLogs.o_traceEvents.label',
                },
              ],
            },
          ],
        },
      ],
    }
    const values: Record<string, unknown> = {
      host: this.config.get('host'),
      port: this.config.get('port'),
      username: this.config.get('username'),
      password: this.config.get('password'),
      debugGeneral: this.config.get('debugGeneral') ?? false,
      debugSocketLogs: this.config.get('debugSocketLogs') ?? [],
      _model: cache?.model ?? 'unknown',
      _channelCount: String(cache?.channelCount ?? 0),
    }
    return hydrateSchema(schema, values)
  }

  /**
   * Pull a fresh Sessions snapshot from the live api. Mirrors
   * `ReolinkCamera.refreshSessionsSnapshot`. Single-flight: concurrent
   * callers fold into the same in-flight promise.
   */
  private async refreshSessionsSnapshot(): Promise<void> {
    if (this.sessionsRefreshInFlight) return this.sessionsRefreshInFlight
    const promise = (async (): Promise<void> => {
      let api: ReolinkBaichuanApi
      try {
        api = await this.ensureApi()
      } catch (err) {
        this.sessionsSnapshot = {
          ts: Date.now(),
          onlineUsers: null,
          socketPool: [],
          dedicatedSessions: [],
          cooldown: null,
          error: err instanceof Error ? err.message : String(err),
        }
        return
      }
      this.sessionsSnapshot = await captureSessionsSnapshot(api, {
        logger: this.ctx.logger,
        deviceId: this.id,
      })
    })().finally(() => {
      this.sessionsRefreshInFlight = null
    })
    this.sessionsRefreshInFlight = promise
    return promise
  }

  /**
   * Apply operator edits to the persisted blob and re-init the
   * Baichuan socket when credentials / host changed. Read-only
   * identity fields (prefixed `_`) are stripped before persist so
   * they don't trip the schema's strict-fields parse.
   */
  override async applySettingsPatch(patch: Record<string, unknown>): Promise<void> {
    // Action sentinels (`_refreshSessions`, …) trigger a side-effect
    // and are stripped before storage. Mirrors `ReolinkCamera`.
    if ('_refreshSessions' in patch) {
      await this.refreshSessionsSnapshot().catch((err) => {
        this.ctx.logger.warn('forced sessions refresh failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
    }
    const writable: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(patch)) {
      if (k.startsWith('_')) continue
      writable[k] = v
    }
    if ('debugSocketLogs' in writable && Array.isArray(writable['debugSocketLogs'])) {
      // Coerce to the schema's flag enum (drops unknown values silently).
      writable['debugSocketLogs'] = (writable['debugSocketLogs'] as readonly unknown[]).filter(
        (v): v is ReolinkSocketDebugFlag =>
          typeof v === 'string' && ReolinkSocketDebugFlagSchema.safeParse(v).success,
      )
    }
    if (Object.keys(writable).length === 0) return
    await this.config.setAll(writable)

    // Connection-affecting changes → tear down + let the reconnect
    // loop re-dial with the new credentials. Pure debug toggles also
    // need a fresh client (DebugOptions are wired at construction).
    const credChanged = ['host', 'port', 'username', 'password', 'transport'].some(
      (k) => k in writable,
    )
    const debugChanged = 'debugGeneral' in writable || 'debugSocketLogs' in writable
    if (credChanged || debugChanged) {
      if (this.api) {
        try {
          await this.api.close({ reason: 'settings-changed' })
        } catch {
          /* best-effort */
        }
        this.api = null
      }
      this.markOnline(false)
      // Re-dial via the reconnect path — on credential change the
      // first dial may fail (operator typo), the loop surfaces it.
      void this.ensureApi().catch((err) => {
        this.ctx.logger.warn('Reolink Hub re-dial after settings change failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
    }
  }

  /**
   * Public accessor for child cameras under this hub. Returns the
   * already-logged-in api (single round-trip on first call). When
   * the api is mid-disconnect, callers wait for the next reconnect.
   */
  async getApi(): Promise<ReolinkBaichuanApi> {
    return this.ensureApi()
  }

  // ── Capability registration ──────────────────────────────────────────

  private registerDeviceDiscovery(): void {
    const provider: InferNativeProvider<typeof deviceDiscoveryCapability> = {
      getStatus: async ({ deviceId }): Promise<DeviceDiscoveryStatus | null> => {
        if (deviceId !== this.id) return null
        return this.runtimeState.getCapState<DeviceDiscoveryStatus>('device-discovery') ?? null
      },
      listDiscovered: async ({ deviceId }): Promise<readonly DiscoveredChildDevice[]> => {
        if (deviceId !== this.id) return []
        const slice = this.runtimeState.getCapState<DeviceDiscoveryStatus>('device-discovery')
        return slice?.discovered ?? []
      },
      refreshDiscovery: async ({ deviceId }): Promise<readonly DiscoveredChildDevice[]> => {
        if (deviceId !== this.id) return []
        await this.refreshDiscoveryFromCamera()
        const slice = this.runtimeState.getCapState<DeviceDiscoveryStatus>('device-discovery')
        return slice?.discovered ?? []
      },
      adoptDevice: async ({
        deviceId,
        childNativeId,
        name,
      }): Promise<{ deviceId: number; stableId: string }> => {
        if (deviceId !== this.id) {
          throw new Error(`adoptDevice: deviceId mismatch — got ${deviceId}, expected ${this.id}`)
        }
        return this.adoptDiscoveredChild(childNativeId, name)
      },
      releaseDevice: async ({ deviceId, childDeviceId }): Promise<void> => {
        if (deviceId !== this.id) return
        await this.releaseDiscoveredChild(childDeviceId)
      },
    }
    this.ctx.registerNativeCap(deviceDiscoveryCapability, provider)
    // Seed the slice ONLY after registerNativeCap installs the
    // runtime-state schema. Pre-register seed throws because the
    // schema validator isn't bound yet; status null means "never
    // discovered yet" so the panel renders an empty state safely.
    this.setCapSlice(deviceDiscoveryCapability, {
      discovered: [],
      lastDiscoveryAt: null,
      lastError: null,
      lastFetchedAt: 0,
    })
  }

  // ── Discovery ────────────────────────────────────────────────────────

  /**
   * Pull the channel list from the Hub via the lib's
   * `getNvrChannelsSummary({ source: 'cgi' })`. CGI is chosen because
   * `GetChannelstatus` returns the channel list
   * synchronously (no race against the cmd_id 145 push cache that
   * can be empty right after login).
   *
   * Persists the result into the device-discovery runtime-state slice
   * so the panel renders the same view across reloads + cross-process.
   */
  private async refreshDiscoveryFromCamera(): Promise<void> {
    let lastError: string | null = null
    let discovered: DiscoveredChildDevice[] = []
    const startedAt = Date.now()

    this.ctx.logger.info('Reolink Hub: discovery refresh started', {
      meta: { source: 'cgi', timeoutMs: HUB_DISCOVERY_REFRESH_TIMEOUT_MS },
    })

    // Which channels we've already adopted as kernel children. Read from
    // the DEVICE REGISTRY (persisted `channel` on each child), never from
    // the CGI summary — see the `channelToDeviceId` sync below.
    const adoptedByChannel = await this.loadAdoptedChildrenByChannel()

    // Simple-event routing map: rebuilt from the registry, BEFORE the CGI
    // call and regardless of whether it succeeds. Previously this was
    // derived from the discovery response, so a battery channel in deep
    // sleep — which `getNvrChannelsSummary` is documented to drop (see
    // `reconcileAdoptedChildOnline`) — had its mapping erased, and every
    // subsequent `awake` / `sleeping` / `battery` / motion push for that
    // channel was silently discarded in `routeSimpleEvent`. Adoption is
    // the only thing that defines this mapping, and adoption lives in the
    // registry.
    //
    // The map is MERGED, never cleared (D49, D173). Clearing it first made a
    // registry read that answered "no children" — which is what an EMPTY
    // registry answers, and the registry is empty for as long as the addon
    // restores its devices — look exactly like "the operator un-adopted
    // everything". The cost was total and silent: `routeSimpleEvent` drops
    // every push for an unmapped channel, so the hub's own battery cameras
    // stopped reporting `awake` / `sleeping` / `battery` for the rest of the
    // process's life, their `battery.sleeping` slice froze on whatever it
    // last held, and every sleep gate that reads it (D173) was then deciding
    // on a value nothing could update. Observed live: both adopted children
    // rendered `alreadyAdopted: false` in the discovery panel — one refresh
    // away from being adopted a second time.
    //
    // A channel is only ever REMOVED from this map by the explicit
    // unregistration path (`releaseDiscoveredChild` / the
    // `DeviceUnregistered` subscription), which is a fact rather than the
    // absence of one.
    for (const [channel, deviceId] of adoptedByChannel) {
      this.channelToDeviceId.set(channel, deviceId)
    }

    try {
      const api = await this.ensureApi()
      const summary = await api.getNvrChannelsSummary({
        source: 'cgi',
        timeoutMs: HUB_DISCOVERY_REFRESH_TIMEOUT_MS,
      })

      discovered = summary.devices.map((d): DiscoveredChildDevice => {
        const childNativeId = computeChildNativeId(this.stableId, d.channel, d.uid)
        // Read the MERGED map, not this refresh's registry read: a read that
        // came back empty because the addon is still restoring its devices
        // must not paint an adopted camera as available (it invites a second
        // adoption of the same channel). Unknown never excludes — D49.
        const adoptedDeviceId = this.channelToDeviceId.get(d.channel) ?? null
        return {
          childNativeId,
          name: d.name ?? `Channel ${d.channel}`,
          // Doorbell vs camera distinction lives in metadata; the
          // adopted child is always a Camera in our type system.
          type: DeviceType.Camera,
          status: discoveredStatusFor(d),
          metadata: {
            ...(d.model ? { model: d.model } : {}),
            ...(d.serialNumber ? { serialNumber: d.serialNumber } : {}),
            ...(d.uid ? { uid: d.uid } : {}),
            rtspChannel: d.channel,
            isBattery: d.isBattery === true,
            isDoorbell: d.isDoorbell === true,
            isMultifocal: d.isMultifocal === true,
          },
          alreadyAdopted: adoptedDeviceId !== null,
          adoptedDeviceId,
        }
      })
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      this.ctx.logger.warn('Reolink Hub discovery refresh failed', {
        meta: { error: lastError },
      })
    }

    const slice: DeviceDiscoveryStatus & { lastFetchedAt: number } = {
      discovered,
      lastDiscoveryAt: Date.now(),
      lastError,
      lastFetchedAt: Date.now(),
    }
    this.runtimeState.setCapState(deviceDiscoveryCapability.name, slice)

    // The hub is the authority on which slot a UID occupies. Repair any adopted child
    // whose persisted `channel` drifted — or vanished — BEFORE the known-unadopted set is
    // rebuilt below, so a healed child is not also advertised as available for adoption.
    if (lastError === null) {
      await this.reconcileChildChannels(discovered)
    }

    if (lastError === null) {
      // Refresh the known-but-unadopted set: pushes from those channels are
      // expected drops (debug), anything else unmapped is a real fault (warn).
      this.knownUnadoptedChannels.clear()
      for (const d of discovered) {
        const ch = d.metadata.rtspChannel
        if (!d.alreadyAdopted && typeof ch === 'number') this.knownUnadoptedChannels.add(ch)
      }
      const adoptedCount = discovered.filter((d) => d.alreadyAdopted).length
      const availableCount = discovered.length - adoptedCount
      const onlineCount = discovered.filter((d) => d.status === 'online').length
      const sleepingCount = discovered.filter((d) => d.status === 'sleeping').length
      this.ctx.logger.info('Reolink Hub: discovery refresh complete', {
        meta: {
          durationMs: Date.now() - startedAt,
          total: discovered.length,
          adopted: adoptedCount,
          available: availableCount,
          online: onlineCount,
          sleeping: sleepingCount,
          channels: discovered.map((d) => ({
            ch: d.metadata.rtspChannel,
            name: d.name,
            model: d.metadata.model ?? null,
            status: d.status,
            adopted: d.alreadyAdopted,
          })),
        },
      })
    }

    // Adopted-child offline reconciliation. Skip when the discovery call
    // itself failed — `discovered === []` then would falsely flag every
    // child offline (firmware blip, transient socket drop). Only act on
    // a successful refresh.
    if (lastError === null) {
      await this.reconcileAdoptedChildOnline(discovered)
      await this.reconcileAdoptedChildSleepState(discovered)
      await this.reconcileAdoptedChildBattery()
    }
  }

  /**
   * Push the hub's per-channel battery read into each adopted battery
   * child. `getAllChannelsBatteryInfo` is one CGI on the hub's own
   * mains-powered socket — it never touches a battery camera — and it is
   * the ONLY way a sleeping hub child's percentage/charging ever moves:
   * the child answers no poll of its own while asleep, and its battery
   * pushes arrive only on firmware transitions (measured live: 3628 sat
   * at 80% / charging:none for 3 h while plugged in, 2026-08-16).
   *
   * Independent of the discovery call's success path: a battery-read
   * failure must not fail discovery, so it is caught and logged here.
   */
  private async reconcileAdoptedChildBattery(): Promise<void> {
    if (this.channelToDeviceId.size === 0) return
    try {
      const api = await this.ensureApi()
      const data = await api.getAllChannelsBatteryInfo()
      const entries = Object.entries(data.batteryInfoData)
      if (entries.length === 0) return
      if (!this.batteryShapeLogged) {
        this.batteryShapeLogged = true
        this.ctx.logger.info('Reolink Hub: per-channel battery payload (first read)', {
          meta: { raw: entries.map(([ch, v]) => ({ channel: Number(ch), ...v })) },
        })
      }
      const all = await this.ctx.devices.getAll()
      for (const [chKey, info] of entries) {
        const deviceId = this.channelToDeviceId.get(Number(chKey))
        if (deviceId === undefined) continue
        const child = all.find((d: { id: number }) => d.id === deviceId)
        if (!(child instanceof ReolinkCamera)) continue
        const cgi = info.entries[0]
        const power = mapHubBatteryPower(cgi)
        for (const { field, value } of power.unmapped) {
          // A code the boundary cannot translate is a FINDING, not a silence:
          // the field is dropped, the camera keeps its previous belief, and
          // without this line a new firmware value would never be seen.
          if (!this.unmappedBatteryCodes.firstSeen(deviceId, field, value)) continue
          this.ctx.logger.warn('Reolink Hub: unmapped battery power code — field dropped', {
            tags: { deviceId },
            meta: { channel: Number(chKey), field, value },
          })
        }
        child.applyHubBatteryInfo({ batteryPercent: info.batteryLevel, ...power.fields })
      }
    } catch (err) {
      this.ctx.logger.debug('Reolink Hub: per-channel battery refresh failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  /**
   * Push the NVR's per-channel sleep state into each adopted battery
   * child's `battery.sleeping` slice.
   *
   * `getNvrChannelsSummary` carries a `sleeping` flag straight from the
   * Hub firmware — obtained over the Hub's own mains-powered socket, so
   * it costs the battery channel nothing, and it is real firmware state
   * rather than the socket-I/O inference a standalone camera has to rely
   * on. Before this it only ever reached the discovery panel; the
   * adopted child's sleep state depended entirely on routed simpleEvents
   * and went stale the moment one was missed. This is the "the NVR
   * already tells us everything" path — with it, a hub-attached battery
   * camera needs no email-push server and no sleep poll of its own.
   *
   * Only `online` / `sleeping` are acted on: `offline` and `unknown`
   * carry no sleep information, so the last known value stands.
   */
  private async reconcileAdoptedChildSleepState(
    discovered: readonly DiscoveredChildDevice[],
  ): Promise<void> {
    const actionable = discovered.filter(
      (e) => e.adoptedDeviceId !== null && (e.status === 'sleeping' || e.status === 'online'),
    )
    if (actionable.length === 0) return
    const all = await this.ctx.devices.getAll()
    for (const entry of actionable) {
      const child = all.find((d: { id: number }) => d.id === entry.adoptedDeviceId)
      if (!(child instanceof ReolinkCamera)) continue
      child.applyHubSleepState(entry.status === 'sleeping')
    }
  }

  /**
   * After a successful discovery refresh, mark every adopted child
   * still seen as `online`, and any child not seen for more than
   * `MISSING_OFFLINE_MS` as `offline`. Mirrors the operator
   * expectation that "if the hub firmware doesn't list it, the
   * device isn't reachable through the hub".
   *
   * Battery cams that briefly disappear from `getNvrChannelsSummary`
   * during deep sleep aren't false-flagged — the threshold gives
   * 3+ refresh cycles of grace.
   */
  private async reconcileAdoptedChildOnline(
    discovered: readonly DiscoveredChildDevice[],
  ): Promise<void> {
    const now = Date.now()
    // Mark every channel still seen NOW.
    const seenChannels = new Set<number>()
    for (const entry of discovered) {
      const ch = entry.metadata.rtspChannel
      if (typeof ch !== 'number' || entry.adoptedDeviceId === null) continue
      seenChannels.add(ch)
      this.childLastSeenAt.set(entry.adoptedDeviceId, now)
    }

    // Walk every adopted child + decide online/offline.
    let children: readonly IDevice[]
    try {
      children = await this.ctx.devices.getChildren(this.id)
    } catch (err) {
      this.ctx.logger.debug('reconcileAdoptedChildOnline: getChildren failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return
    }
    for (const child of children) {
      const cfg = (child.config as { values: unknown }).values as { channel?: number } | undefined
      const ch = cfg?.channel
      if (typeof ch !== 'number') continue
      // Accessory grand-children (siren / floodlight / pir attached to
      // a hub-adopted camera) carry their own parent linkage and are
      // out of scope here — we only reconcile direct camera children.
      if (child.type !== DeviceType.Camera) continue

      const wasSeenNow = seenChannels.has(ch)
      const lastSeen = this.childLastSeenAt.get(child.id) ?? 0
      const missingMs = wasSeenNow ? 0 : lastSeen > 0 ? now - lastSeen : Number.POSITIVE_INFINITY

      // Cast to the live ReolinkCamera shape — `markOnline` is part of
      // the IDevice surface but not narrowed by the type system here.
      const live = child as { online: boolean; markOnline: (online: boolean) => void }

      if (wasSeenNow) {
        if (live.online !== true) {
          live.markOnline(true)
          this.ctx.logger.info('Reolink Hub: adopted child back online', {
            tags: { deviceId: child.id, deviceName: child.name },
            meta: { channel: ch },
          })
        }
        continue
      }
      if (missingMs >= ReolinkHub.MISSING_OFFLINE_MS) {
        if (live.online !== false) {
          live.markOnline(false)
          this.ctx.logger.warn(
            'Reolink Hub: adopted child marked offline (missing from discovery)',
            {
              tags: { deviceId: child.id, deviceName: child.name },
              meta: { channel: ch, missingMs },
            },
          )
        }
      }
    }
  }

  /**
   * Walks the kernel device registry for children with `parentDeviceId
   * === this.id` and reads each child's persisted config to extract
   * the channel index. Returns a `channel → kernel deviceId` map.
   * Used to gate the `alreadyAdopted` flag in the discovery list.
   */
  /**
   * Re-derive each adopted child's `channel` from the hub's own channel list, matching by
   * IDENTITY (stableId carries the camera UID) rather than by the channel itself.
   *
   * `loadAdoptedChildrenByChannel` keys the adopted set on the persisted `channel` alone,
   * so a child that lost it is invisible: the discovery panel renders it available (one
   * click from a second adoption of the same camera) and `routeSimpleEvent` drops every
   * push for its slot. A channel move produces the same damage under a wrong number.
   *
   * Writes through the live device so its in-memory config and the DB stay in step.
   * A child that is not live is skipped — it is repaired on its next successful restore.
   */
  private async reconcileChildChannels(
    discovered: readonly DiscoveredChildDevice[],
  ): Promise<void> {
    const children = await this.ctx.devices.getChildren(this.id)
    const adopted = children.map((child) => {
      const channel = child instanceof ReolinkCamera ? child.config.values.channel : undefined
      return {
        deviceId: child.id,
        stableId: child.stableId,
        ...(typeof channel === 'number' ? { channel } : {}),
      }
    })
    const repairs = planChannelReconciliation(
      this.stableId,
      discovered.map((d) => ({
        childNativeId: d.childNativeId,
        ...(typeof d.metadata.rtspChannel === 'number'
          ? { rtspChannel: d.metadata.rtspChannel }
          : {}),
      })),
      adopted,
    )
    if (repairs.length === 0) return

    for (const repair of repairs) {
      const child = children.find((c) => c.id === repair.deviceId)
      if (!(child instanceof ReolinkCamera)) continue
      try {
        await child.config.setAll({ channel: repair.to })
        this.channelToDeviceId.set(repair.to, repair.deviceId)
        this.ctx.logger.warn('Reolink Hub: repaired a child channel from the hub channel list', {
          tags: { deviceId: repair.deviceId, stableId: repair.stableId },
          meta: { from: repair.from, to: repair.to },
        })
      } catch (err) {
        this.ctx.logger.warn('Reolink Hub: child channel repair failed', {
          tags: { deviceId: repair.deviceId, stableId: repair.stableId },
          meta: {
            from: repair.from,
            to: repair.to,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
    }
  }

  private async loadAdoptedChildrenByChannel(): Promise<Map<number, number>> {
    const result = new Map<number, number>()
    const children = await this.ctx.devices.getChildren(this.id)
    for (const child of children) {
      // Each adopted ReolinkCamera carries its channel in the persisted
      // config blob. `BaseDevice.config.values` returns the parsed shape.
      const cfg = (child.config as { values: unknown }).values as { channel?: number } | undefined
      const ch = cfg?.channel
      if (typeof ch === 'number') result.set(ch, child.id)
    }
    return result
  }

  /**
   * Promote a discovered channel to a real `ReolinkCamera` child. The
   * child inherits credentials + transport from the Hub and stores
   * its `channel` so the lib's per-channel routing (RTSP URL,
   * settings calls, snapshot fetch) works without reaching back into
   * the Hub for every read.
   */
  private async adoptDiscoveredChild(
    childNativeId: string,
    nameOverride?: string,
  ): Promise<{ deviceId: number; stableId: string }> {
    const slice = this.runtimeState.getCapState<DeviceDiscoveryStatus>('device-discovery')
    const entry = slice?.discovered.find((d) => d.childNativeId === childNativeId)
    if (!entry) {
      throw new Error(`adoptDevice: ${childNativeId} not in discovered list — refresh first`)
    }
    if (entry.alreadyAdopted && entry.adoptedDeviceId !== null) {
      // Idempotent — return the existing child id rather than erroring.
      const all = await this.ctx.devices.getAll()
      const existing = all.find((d: IDevice) => d.id === entry.adoptedDeviceId)
      if (existing) return { deviceId: existing.id, stableId: existing.stableId }
    }
    const channel = entry.metadata.rtspChannel
    if (typeof channel !== 'number') {
      throw new Error(
        `adoptDevice: ${childNativeId} has no rtspChannel — corrupt discovery payload`,
      )
    }

    const hubCfg = this.config.values
    const childConfig = {
      // Children inherit Hub credentials (reuse parent socket).
      host: hubCfg.host,
      port: hubCfg.port,
      username: hubCfg.username,
      password: hubCfg.password,
      transport: hubCfg.transport,
      ...(entry.metadata.uid ? { uid: entry.metadata.uid } : {}),
      // Channel is the discriminator that turns a "regular camera"
      // config into "this slot under this hub". `ReolinkCamera`
      // detects parentDeviceId !== null and uses parent.api instead
      // of dialling its own login.
      channel,
      deviceCache: {
        deviceType: 'camera' as const,
        channelCount: 1,
        ...(entry.metadata.model ? { model: entry.metadata.model } : {}),
        ...(entry.metadata.isBattery !== undefined ? { hasBattery: entry.metadata.isBattery } : {}),
        ...(entry.metadata.isDoorbell !== undefined
          ? { hasDoorbell: entry.metadata.isDoorbell }
          : {}),
        // NOTE: do NOT set `probedAt` here. The metadata above
        // is the discovery-CGI snapshot — it doesn't carry
        // hasPtz/hasIntercom/hasFloodlight/hasSiren/hasAutotrack.
        // `ensureFeaturesProbed()` (called below, line ~528)
        // gates on `probedAt` to decide whether to run the live
        // capabilities probe; setting it here would early-return
        // and the freshly-adopted child would be stuck with the
        // discovery-only flag set forever (until manual refresh).
      },
    }

    const stableId = `${this.stableId}-${childNativeId}`
    this.ctx.logger.info('Reolink Hub: adopting child', {
      meta: {
        childNativeId,
        channel,
        name: nameOverride ?? entry.name,
        model: entry.metadata.model ?? null,
        isBattery: entry.metadata.isBattery === true,
        isDoorbell: entry.metadata.isDoorbell === true,
        stableId,
      },
    })
    const created = await this.ctx.devices.create(stableId, ReolinkCamera, childConfig, this.id, {
      type: DeviceType.Camera,
      name: nameOverride ?? entry.name,
    })
    // The kernel's `register()` already runs the lifecycle phases
    // (onProbe → reconcile accessories → onActivate) inline before
    // `kernel.devices.create()` returns. By the time we're here, the
    // freshly-adopted child has its `features` array populated AND its
    // accessory children spawned. No additional probe call needed.
    this.ctx.logger.info('Reolink Hub: child adopted', {
      tags: { deviceId: created.id },
      meta: { childNativeId, channel, stableId, features: [...created.features] },
    })

    // Mirror the new mapping immediately so simpleEvents that arrive
    // before the next discovery refresh hit the right child.
    this.channelToDeviceId.set(channel, created.id)
    // AWAIT the refresh before returning so the runtime-state slice
    // is up-to-date by the time the UI's `onSuccess` invalidator
    // fires `listDiscovered.invalidate({deviceId})`. Fire-and-forget
    // here used to leave the panel staring at stale data until the
    // next 10s poll tick — operator had to refresh the page.
    await this.refreshDiscoveryFromCamera().catch(() => {
      /* best-effort */
    })

    return { deviceId: created.id, stableId }
  }

  /**
   * Inverse of `adoptDevice`: removes the child from the kernel
   * registry. The discovered entry remains in the discovery list so
   * the operator can re-adopt without a fresh refresh.
   */
  private async releaseDiscoveredChild(childDeviceId: number): Promise<void> {
    const all = await this.ctx.devices.getAll()
    const child = all.find((d: IDevice) => d.id === childDeviceId)
    if (!child || child.parentDeviceId !== this.id) {
      throw new Error(`releaseDevice: ${childDeviceId} is not a child of hub ${this.id}`)
    }
    this.ctx.logger.info('Reolink Hub: releasing child', {
      tags: { deviceId: childDeviceId },
      meta: { stableId: child.stableId, name: child.name },
    })
    await this.ctx.devices.remove(childDeviceId)

    // Drop the channel mapping eagerly so post-release events don't
    // route into a freed device. Refresh syncs the panel state.
    for (const [ch, did] of this.channelToDeviceId.entries()) {
      if (did === childDeviceId) this.channelToDeviceId.delete(ch)
    }
    this.ctx.logger.info('Reolink Hub: child released', {
      tags: { deviceId: childDeviceId },
    })
    // Same await pattern as adoptDiscoveredChild — make the slice fresh
    // before the mutation returns so the panel's invalidate sees the
    // post-release state on first re-fetch.
    await this.refreshDiscoveryFromCamera().catch(() => {
      /* best-effort */
    })
  }

  // ── Event routing ────────────────────────────────────────────────────

  /**
   * Dispatches a Hub-received simpleEvent to the matching child's
   * `handleSimpleEvent`.
   */
  private routeSimpleEvent(ev: ReolinkSimpleEvent): void {
    const channel = ev?.channel
    if (typeof channel !== 'number') return
    // Consumed now, synchronously with the raw emit it belongs to — the child
    // lookup below is async.
    const motionSensor = ev.type === 'motion' ? this.motionSensors.take(channel) : null
    const deviceId = this.channelToDeviceId.get(channel)
    if (deviceId === undefined) {
      // An unmapped channel means every push for it dies here invisibly —
      // which is exactly how a boot-raced map turned hub children into
      // cameras that could never be seen to wake or sleep (2026-08-15).
      // Log it ONCE per channel (throttled — a chatty channel must not
      // flood), so the failure is falsifiable in the field.
      //
      // A channel the last discovery refresh saw but the operator chose
      // NOT to adopt (e.g. ch3 "Magicam", 2026-08-16) is an expected
      // drop, not a fault — debug, not warn.
      const last = this.unroutedChannelLoggedAt.get(channel) ?? 0
      const now = Date.now()
      if (now - last > 60_000) {
        this.unroutedChannelLoggedAt.set(channel, now)
        const knownUnadopted = this.knownUnadoptedChannels.has(channel)
        this.ctx.logger[knownUnadopted ? 'debug' : 'warn'](
          'Reolink Hub: simpleEvent for an unmapped channel dropped',
          { meta: { channel, type: ev?.type ?? 'unknown', knownUnadopted } },
        )
      }
      return
    }
    void this.ctx.devices
      .getAll()
      .then((all) => all.find((d) => d.id === deviceId))
      .then((child) => {
        if (!(child instanceof ReolinkCamera)) return
        // Hub-child events never hit the camera's own Baichuan socket, so
        // enabling debug on the child does not produce lib traces — and the
        // camera's `simpleEvent received` line is tagged with the CHILD
        // deviceId. Log here, on the Hub logger, before dispatch, so an
        // operator filtering Logs to the Hub (or to a debug camera) can
        // see that the push arrived and which child it was about to hit.
        if (
          shouldTraceSimpleEventDispatch({
            hubDebugGeneral: this.config.get('debugGeneral') === true,
            hubSocketFlags: asDebugSocketFlags(this.config.get('debugSocketLogs')),
            childDebugGeneral: child.config.get('debugGeneral') === true,
            childSocketFlags: asDebugSocketFlags(child.config.get('debugSocketLogs')),
          })
        ) {
          this.ctx.logger.info('Reolink Hub: simpleEvent dispatch', {
            meta: {
              type: ev?.type ?? 'unknown',
              channel,
              timestamp: ev?.timestamp,
              deviceId: child.id,
              name: child.name,
            },
          })
        }
        child.handleSimpleEvent(ev, motionSensor)
      })
      .catch((err) => {
        this.ctx.logger.debug('Hub simpleEvent dispatch failed', {
          meta: {
            channel,
            deviceId,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      })
  }

  // ── Connect / reconnect ──────────────────────────────────────────────

  private async ensureApi(): Promise<ReolinkBaichuanApi> {
    if (this.api && this.api.client.isSocketConnected() && this.api.client.loggedIn) {
      return this.api
    }
    if (this.connectInFlight) return this.connectInFlight
    this.connectInFlight = this.connect().finally(() => {
      this.connectInFlight = null
    })
    return this.connectInFlight
  }

  private async connect(): Promise<ReolinkBaichuanApi> {
    if (this.api) {
      try {
        await this.api.close({ reason: 'hub-reconnect' })
      } catch {
        /* best-effort */
      }
      this.api = null
    }
    const cfg = this.config.values
    if (!cfg.host)
      throw userError('reolink.hub-host-missing', undefined, 'Reolink Hub: host not configured')
    if (!cfg.password)
      throw userError(
        'reolink.hub-password-missing',
        undefined,
        'Reolink Hub: password not configured',
      )

    const api = new ReolinkBaichuanApi({
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      password: cfg.password,
      transport: cfg.transport,
      ...(cfg.uid ? { uid: cfg.uid } : {}),
    })
    this.ctx.logger.info('Reolink Hub connecting', {
      meta: { host: cfg.host, port: cfg.port, transport: cfg.transport },
    })
    await api.login()

    // Subscribe simpleEvent BEFORE the first refresh so events that
    // fire during enumeration (online/sleeping bursts on Hub login)
    // hit the routing path even if no child is adopted yet.
    try {
      await api.offSimpleEvent(this.handleSimpleEventBound)
    } catch {
      /* first subscribe — handler not registered */
    }
    this.observeMotionSensors(api)
    await api.onSimpleEvent(this.handleSimpleEventBound)

    api.client.on('close', () => this.scheduleReconnect('socket-close'))
    api.client.on('error', (err) => {
      this.ctx.logger.warn('Reolink Hub socket error — scheduling reconnect', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      this.scheduleReconnect('socket-error')
    })

    this.api = api
    this.reconnectAttempts = 0
    this.markOnline(true)

    // Initial discovery — non-blocking; the panel hydrates from the
    // slice and shows "loading" until the first refresh lands.
    void this.refreshDiscoveryFromCamera().catch(() => {
      /* best-effort */
    })

    // Hardware metadata blob — populates the device-meta `metadata`
    // field consumed by the device-detail Hardware sub-tab. Mirrors
    // `ReolinkCamera.populateMetadataFromFirmware`. Best-effort;
    // failures leave the existing blob untouched.
    void this.populateMetadataFromFirmware(api).catch(() => {
      /* best-effort */
    })

    return api
  }

  /** Pull `getInfo` + `getNetworkInfo` and patch the device-meta
   *  metadata blob + the deviceCache durable-identifier fields.
   *  Shared implementation with `ReolinkCamera` — see
   *  `metadata-populator.ts`. */
  private async populateMetadataFromFirmware(api: ReolinkBaichuanApi): Promise<void> {
    const cfgUid = this.config.values['uid']
    // Hub IS the host — pass `undefined` channel so the populator
    // hits cmd 80 (host getInfo) + cmd 76 host (getNetworkInfo).
    // Passing `0` would route to cmd 318 ch=0 / cmd 76 ch=0 — which
    // returns one of the attached cameras' data, polluting the hub's
    // metadata blob with a sibling's identity.
    await populateReolinkMetadata(api, undefined, {
      id: this.id,
      ctx: this.ctx,
      uid: typeof cfgUid === 'string' && cfgUid.length > 0 ? cfgUid : undefined,
      setDeviceCachePatch: async (cachePatch) => {
        const previous = this.config.get('deviceCache') ?? {}
        await this.config.setAll({ deviceCache: { ...previous, ...cachePatch } })
      },
    })
  }

  private scheduleReconnect(reason: string): void {
    if (this.shutdownRequested) return
    this.api = null
    this.markOnline(false)
    if (this.reconnectTimer) return
    const backoff = Math.min(
      HUB_RECONNECT_BASE_MS * 2 ** this.reconnectAttempts,
      HUB_RECONNECT_MAX_MS,
    )
    this.reconnectAttempts += 1
    this.ctx.logger.info('Reolink Hub reconnect scheduled', {
      meta: { reason, attempt: this.reconnectAttempts, backoffMs: backoff },
    })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.ensureApi().catch(() => {
        /* logged in connect() */
      })
    }, backoff)
  }

  /**
   * Adopt a pre-built api (used by `onCreateDevice` to reuse the
   * autodetect socket — Slice 15 socket reuse). Mirrors
   * `ReolinkCamera.adoptApi`.
   */
  adoptApi(api: ReolinkBaichuanApi): void {
    this.api = api
    this.reconnectAttempts = 0
    this.markOnline(true)
    this.observeMotionSensors(api)
    api.client.on('close', () => this.scheduleReconnect('socket-close'))
    api.client.on('error', (err) => {
      this.ctx.logger.warn('Reolink Hub adopted socket error', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      this.scheduleReconnect('socket-error')
    })
    void api
      .offSimpleEvent(this.handleSimpleEventBound)
      .catch(() => {
        /* first subscribe */
      })
      .then(() => api.onSimpleEvent(this.handleSimpleEventBound))
      .then(() => this.refreshDiscoveryFromCamera())
      .catch((err) => {
        this.ctx.logger.warn('Reolink Hub post-adopt discovery failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
  }
}

// ── helpers ────────────────────────────────────────────────────────────

/**
 * Build a stable per-child identifier. UID is preferred when available
 * (uniquely identifies a paired camera across re-pairings); otherwise
 * we fall back to `channel-N` which is stable for a fixed channel
 * assignment.
 */
function computeChildNativeId(parentStableId: string, channel: number, uid?: string): string {
  void parentStableId
  if (uid && uid.length > 0) return `cam-${uid}`
  return `channel-${channel}`
}

/**
 * Map the lib's per-channel summary booleans to our `DiscoveredChildStatus`.
 * Order of precedence:
 *   1. `online === false` → offline
 *   2. `sleeping === true` → sleeping
 *   3. anything else with non-empty state → online
 *   4. unknown otherwise (cmd_id 145 push hasn't landed yet)
 */
function discoveredStatusFor(d: {
  online?: boolean
  sleeping?: boolean
  state?: string
}): DiscoveredChildStatus {
  if (d.online === false) return 'offline'
  if (d.sleeping === true) return 'sleeping'
  if (d.online === true) return 'online'
  if (typeof d.state === 'string' && d.state.length > 0) return 'online'
  return 'unknown'
}

/**
 * The hub CGI reports charge state as NUMERIC codes (measured live on the
 * Home Hub, 2026-08-16: a full, plugged Argus 3E reads chargeStatus 2 /
 * adapterStatus 1) while `mapBatteryInfo` speaks the standalone Baichuan
 * string vocabulary ('charging' / 'chargeComplete' / 'solarPanel'). Translate
 * at the hub boundary so the shared mapper stays untouched.
 *   chargeStatus: 0 none · 1 charging · 2 charge complete
 *   adapterStatus: 0 none · 1 DC adapter · 2 solar panel
 */
