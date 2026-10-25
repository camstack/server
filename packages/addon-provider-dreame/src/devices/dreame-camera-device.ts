import type {
  BaseDevice as DreameBaseDevice,
  DreameCameraController,
} from '@apocaliss92/nodedreame'
import { DreameCameraStream, VacuumDevice as DreameVacuum } from '@apocaliss92/nodedreame'
import {
  type BatteryStatus,
  batteryCapability,
  type ConfigUISchema,
  type ConfigUISchemaWithValues,
  createEvent,
  type DeviceContext,
  DeviceFeature,
  EventCategory,
  errMsg,
  hydrateSchema,
  type InferNativeProvider,
  type NavigationFeatures,
  type NavigationRuntimeState,
  type NavigationStatus,
  navigationCapability,
  networkLinkCapability,
  type RecordingSignalRuntimeState,
  recordingSignalCapability,
  streamCatalogCapability,
  type VacuumState,
} from '@camstack/types'
import { mapMiotStateToVacuumState } from '../dreame-vacuum-decode.js'
import {
  advertisedRfcHost,
  CAMERA_STREAM_ID,
  type CameraStreamSession,
  cameraBatterySlice,
  cameraStreamCatalog,
  MAX_STREAM_MS,
  relayHubAddress,
  rfcUrl,
  WAKE_TIMEOUT_MS,
} from './dreame-camera-stream.js'
import { DreameChildDevice } from './dreame-child-device.js'
import { classifyPinRefusal, PinAttention } from './dreame-pin-attention.js'
import {
  actionCall,
  type ControllerCall,
  goToPointCall,
  lightLevelCall,
  lightModeCall,
  lightOnCall,
  moveCall,
  playSoundCall,
  runControllerCall,
  stopCall,
} from './dreame-navigation-actions.js'
import {
  dreameNavigationCatalog,
  resolveDisabledEntryIds,
  resolveNavigationFeatures,
} from './dreame-navigation-config.js'
import { decodeFollowing, decodeNavigationReadback } from './dreame-navigation-status.js'
import { DreameNetworkLinkMonitor } from './dreame-network-link.js'
import { seedDeviceDecisionRecording } from './dreame-recording-seed.js'
import { RECORDING_SIGNAL_COLD_START, recordingSignalSlice } from './dreame-recording-signal.js'
import { type FeedLoss, type RfcServerInfo, startRfc4571Server } from './dreame-rfc4571-server.js'

const CAP_NAME = 'navigation'

/**
 * How long a monitor may stay open WHILE THE ROBOT IS IN FUNCTION before the
 * duration cap closes it anyway. `MAX_STREAM_MS` (10 min) is the plugin's cap
 * for a viewer's session; a recording that follows the cleaning
 * (`recording-signal`) would be cut every ten minutes by it, with a re-open
 * gap each time, so while the signal is active the cap is re-armed up to this
 * absolute bound. Three hours covers the longest whole-house job observed; a
 * consumer that leaves still closes the session on the spot, so this never
 * keeps a relay open for nobody.
 */
export const MAX_STREAM_WHILE_ACTIVE_MS = 3 * 60 * 60_000

/**
 * The slice as WRITTEN: the cap's runtime-state shape (status + `lastFetchedAt`).
 * `setCapState` validates against it, so a status-only object throws at
 * activation and registers nothing — which is how the first deploy shipped
 * a camera with no navigation and no PTZ.
 */
export const NAV_COLD_START: NavigationRuntimeState = {
  mode: 'unknown',
  following: false,
  flash: false,
  lightMode: 'auto',
  lightLevel: 100,
  lastChangedAt: 0,
  lastFetchedAt: 0,
}

/** The next slice: the previous one, the patch, and both clocks stamped `now`. */
export function navigationSlice(
  prev: NavigationRuntimeState,
  patch: Partial<NavigationStatus>,
  now: number,
): NavigationRuntimeState {
  return { ...prev, ...patch, lastChangedAt: now, lastFetchedAt: now }
}

/**
 * Dreame CAMERA + NAVIGATION device — a SEPARATE camstack device from the
 * `DreameVacuumDevice`, spawned only for camera-capable vacuums (those whose
 * `vacuumCapabilities.hasCamera` is true, i.e. a LinkVisual video surface). It
 * owns the `navigation` cap (drive joystick + discrete robot actions + sounds +
 * fill light); the vacuum device keeps `vacuum-control` / `consumables` / maps.
 *
 * PREBUFFER OFF: this is a BATTERY robot whose camera is expensive to cold-start,
 * so the device advertises {@link DeviceFeature.BatteryOperated} — the SAME flag
 * the Reolink battery-camera path uses. The stream-broker's
 * `getEffectivePreBufferSec` battery rule then sets `preBufferSec = 0`, so the
 * stream opens on demand and is never continuously prebuffered.
 *
 * The whole navigation surface goes through nodedreame's typed
 * `DreameCameraController` (1.12+, built lazily from the vacuum handle with the
 * pairing PIN when the camera is coded), mapped by `dreame-navigation-actions.ts`.
 * The controller is never `open()`ed here — the stream is the broker's; drive is
 * valid only while a stream is open, which is when the panel is used.
 *
 * STATUS: `mode` is mapped from the shared vacuum state; `flash` / `lightMode`
 * / `lightLevel` are decoded from the robot's own properties on every push
 * (`dreame-navigation-status.ts`: `4/50` and `10001/9`) and, until the first
 * read-back lands, from the commands this device issued. `following` has no
 * confirmed read-back yet and stays command-driven.
 *
 * `navigation` is its own capability, deliberately NOT projected as `ptz`: a
 * gimbal and a chassis are different physical models, and the operator asked
 * for two separate things (admin UI: two tabs; viewer: one panel that shows the
 * navigation controls when the device has the cap).
 */
/**
 * The camera child's settings form.
 *
 * A PURE export so the shape can be asserted without constructing a device —
 * the same discipline `navigationSlice` follows in this file. What matters
 * here is that the backend selector offers exactly the two vendors this
 * library can stream, in the order that puts the working one first.
 */
export const CAMERA_SETTINGS_SCHEMA: ConfigUISchema = {
  sections: [
    {
      id: 'camera-backend',
      title: 'Video backend',
      titleKey: 'provider-dreame:camera_settings.s_camera-backend.title',
      description:
        'Only the Aliyun path is implemented; a robot on Tencent cannot be viewed by CamStack. Changing this asks the robot to switch.',
      descriptionKey: 'provider-dreame:camera_settings.s_camera-backend.description',
      fields: [
        {
          type: 'select',
          key: 'videoVendor',
          label: 'Backend',
          labelKey: 'provider-dreame:camera_settings.s_camera-backend.videoVendor.label',
          options: [
            {
              value: 'ali',
              label: 'Aliyun LinkVisual (supported)',
              labelKey: 'provider-dreame:camera_settings.s_camera-backend.videoVendor.o_ali.label',
            },
            {
              value: 'tx',
              label: 'Tencent IoT-Video (not implemented yet)',
              labelKey: 'provider-dreame:camera_settings.s_camera-backend.videoVendor.o_tx.label',
            },
          ],
        },
      ],
    },
    {
      id: 'camera-access',
      title: 'Camera access',
      titleKey: 'provider-dreame:camera_settings.s_camera-access.title',
      description:
        'The privacy code set when the robot camera was paired. The robot refuses to open its camera without it.',
      descriptionKey: 'provider-dreame:camera_settings.s_camera-access.description',
      fields: [
        {
          type: 'password',
          key: 'navigationAccessCode',
          label: 'Camera access code',
          labelKey: 'provider-dreame:camera_settings.s_camera-access.navigationAccessCode.label',
          showToggle: true,
        },
      ],
    },
  ],
}

/**
 * The values the form opens with.
 *
 * The DEVICE wins: it is the authority on which backend it is on, and the
 * stored preference is only what the operator last asked for. Showing the
 * preference while the robot sits elsewhere would tell the operator the switch
 * had worked when it had not. Before the first read has answered there is
 * nothing to show but the preference, and an empty string when there is
 * neither — unknown, never a default that looks like a fact (D393).
 */
export function cameraSettingsValues(input: {
  readonly accessCode?: string | undefined
  readonly vendorNow?: string | null
  readonly storedVendor?: string | undefined
}): Record<string, unknown> {
  return {
    navigationAccessCode: input.accessCode ?? '',
    videoVendor: input.vendorNow ?? input.storedVendor ?? '',
  }
}

export class DreameCameraDevice extends DreameChildDevice {
  // Battery robot → prebuffer off (mirrors the Reolink battery-camera rule).
  override readonly features: readonly DeviceFeature[] = [DeviceFeature.BatteryOperated]

  // Widen the base's protected constructor to public so the factory can `new` it.
  // oxlint-disable-next-line no-useless-constructor
  constructor(ctx: DeviceContext) {
    super(ctx)
  }

  protected override registerControlCap(): void {
    const provider = this.buildNavigationProvider()
    this.ctx.registerNativeCap(navigationCapability, provider)
    this.runtimeState.setCapState(CAP_NAME, NAV_COLD_START)
    this.registerBatteryCap()
    // The robot's link on its camera too: the player shows the signal of the
    // device it is looking at, and the vacuum is a different device.
    this.ctx.registerNativeCap(networkLinkCapability, this.networkLink.provider())
    this.networkLink.seed()
    this.networkLink.start()
    this.registerStreamCatalogCap()
    this.registerRecordingSignalCap()
    // Once, ever: a camera that can ask to be recorded and is configured by
    // nobody records nothing. Fire-and-forget — the activation path must not
    // wait on the hub, and the seed never throws (D380).
    void this.seedRecordingConfig()
  }

  /**
   * Seed `on-device-decision` recording the FIRST time this camera comes up.
   *
   * Gated on the durable mark and NOT on the current config: an operator who
   * switched recording off leaves a config that is byte-identical to one that
   * was never seeded, so reading the value would re-enable it at every restart.
   * The value stays the recorder's (D62) — this writes a default through the
   * same cap method an operator uses and keeps no copy of it.
   */
  private async seedRecordingConfig(): Promise<void> {
    await seedDeviceDecisionRecording({
      deviceId: this.id,
      alreadySeeded: this.config.get('recordingSeededAt') !== undefined,
      writeConfig: (config) =>
        this.ctx.api.recordingArchive.setDeviceConfig.mutate({ deviceId: this.id, config }),
      markSeeded: () => this.config.set('recordingSeededAt', Date.now()),
      logger: this.ctx.logger,
    })
  }

  /**
   * The camera's own "record me" LEVEL, derived from the vacuum lifecycle
   * state on every push (`recomputeSlice`). The recorder follows it
   * (`RecordingTriggers.deviceSignal`): a cleaning is one clip, opened by the
   * rise (which wakes this camera through `battery.wakeForStream` like any
   * consumer) and closed by the fall.
   */
  private registerRecordingSignalCap(): void {
    const provider: InferNativeProvider<typeof recordingSignalCapability> = {
      getStatus: async () => {
        const slice = this.recordingSignal()
        return { active: slice.active, reason: slice.reason, lastChangedAt: slice.lastChangedAt }
      },
    }
    this.ctx.registerNativeCap(recordingSignalCapability, provider)
    this.runtimeState.setCapState(recordingSignalCapability.name, RECORDING_SIGNAL_COLD_START)
  }

  private recordingSignal(): RecordingSignalRuntimeState {
    return (
      this.runtimeState.getCapState<RecordingSignalRuntimeState>(recordingSignalCapability.name) ??
      RECORDING_SIGNAL_COLD_START
    )
  }

  /** Write the signal only when the LEVEL or its reason moved: every write is
   *  a `setCapSlice` RPC, and the robot pushes far more often than it changes state. */
  private publishRecordingSignal(state: VacuumState): void {
    const prev = this.recordingSignal()
    const next = recordingSignalSlice(prev, state, Date.now())
    if (next.active === prev.active && next.reason === prev.reason) return
    this.runtimeState.setCapState(recordingSignalCapability.name, next)
    if (next.active !== prev.active) {
      this.ctx.logger.info('robot camera: recording signal changed', {
        tags: { deviceId: this.id },
        meta: { active: next.active, reason: next.reason },
      })
    }
  }

  // ── The stream: on demand, through the broker's battery path ──────────
  //
  // A Dreame relay carries video only between `open()` and `close()`, and the
  // robot runs on a battery, so the camera cannot sit in the catalog with a
  // URL the way a mains camera does. The seam is the one the broker already
  // has for battery cameras (`battery-wake-on-play.ts`): while the monitor is
  // CLOSED the battery slice says `sleeping` and the catalog is EMPTY, so a
  // play finds no broker and asks for a wake; `wakeForStream` opens the
  // monitor, the catalog reconcile that follows reads the relay URL, and the
  // broker pulls it. The monitor closes again when the consumer leaves, when
  // the duration cap fires, when the relay's keep-alive fails — and when the
  // FEED dies under an open monitor (a socket error, a relay that closed, a
  // stall): a session whose port accepts and sends nothing must not be
  // re-published to a broker asking for a refresh, it must go back to the
  // lazy sentinel so the next dial is a wake (D424).

  /** One reader of the robot's link, shared in shape with the vacuum's. */
  /**
   * Where the robot says its video backend is, as last read.
   *
   * The settings schema is built synchronously and this is a device read, so
   * it is cached and refreshed in the background when the form is opened — the
   * serve-and-revalidate discipline D224 describes.
   *
   * `null` means never read, which the form shows as the stored preference
   * instead — unknown is not the same fact as "on ali" (D393).
   */
  private vendorNow: string | null = null

  /** Refresh {@link vendorNow}. Never throws: the settings page must open
   *  whether or not the robot answered. */
  private async refreshVendorNow(): Promise<void> {
    const handle = this.resolveHandle()
    if (!(handle instanceof DreameVacuum)) return
    try {
      // LIVE, not the cloud shadow. The shadow lags a switch by minutes, and
      // this refresh OVERWRITES what the switch itself observed — so reading
      // it cached made the form report `tx` moments after the robot had
      // moved to `ali` and said so. A property read does not open the camera;
      // it costs the same MIoT round-trip the signal monitor already makes.
      this.vendorNow = (await handle.readVideoVendorStatus({ live: true })).vendor
    } catch (err) {
      this.ctx.logger.debug('robot camera: video backend read failed', {
        tags: { deviceId: this.id },
        meta: { error: errMsg(err) },
      })
    }
  }

  private readonly networkLink = new DreameNetworkLinkMonitor({
    deviceId: this.id,
    logger: this.ctx.logger,
    runtimeState: this.runtimeState,
    readBars: () => {
      const handle = this.resolveHandle()
      return handle instanceof DreameVacuum ? handle.getCurrentSignal({ maxWaitMs: 20_000 }) : null
    },
  })

  /** The local RFC 4571 server the broker pulls; null while the monitor is closed. */
  private session: CameraStreamSession | null = null
  /** What the open session owns: the frame feed and its TCP server. */
  private live: { readonly stream: DreameCameraStream; readonly rfc: RfcServerInfo } | null = null
  /** A single in-flight open — two plays must not cold-start the robot twice. */
  private opening: Promise<void> | null = null
  /** The plugin's cap: a monitor never outlives `MAX_STREAM_MS` — unless the
   *  robot is in function, see {@link onMaxDuration}. */
  private maxTimer: NodeJS.Timeout | null = null
  /** When the open session was published — the clock `MAX_STREAM_WHILE_ACTIVE_MS` reads. */
  private sessionOpenedAt = 0
  /** Last time the robot said anything (a state change) — the wake refusal's evidence. */
  private lastContactAt: number | null = null

  private registerBatteryCap(): void {
    const provider: InferNativeProvider<typeof batteryCapability> = {
      wakeForStream: async ({ timeoutMs }) => this.wakeForStream(timeoutMs),
    }
    this.ctx.registerNativeCap(batteryCapability, provider)
    this.publishBattery()
    this.runtimeState.subscribeCap<BatteryStatus>(batteryCapability.name, (slice) => {
      if (!slice) return
      this.ctx.eventBus.emit(
        createEvent(
          EventCategory.BatteryOnStatusChanged,
          { type: 'device', id: this.stableId },
          { deviceId: this.id, status: slice },
        ),
      )
    })
  }

  private registerStreamCatalogCap(): void {
    const provider: InferNativeProvider<typeof streamCatalogCapability> = {
      getCatalog: async ({ deviceId }) =>
        deviceId === this.id ? cameraStreamCatalog(this.session) : [],
    }
    this.ctx.registerNativeCap(streamCatalogCapability, provider)
    this.publishCatalog()
    void this.publishRelay(null)
    // The broker's first dial of the lazy sentinel — and any dial that failed
    // — asks the publisher to materialize the source. For the robot that IS
    // the wake: open the monitor, and the open publishes the real server.
    // Already open: re-publish what stands.
    this.unsubscribeRefresh?.()
    this.unsubscribeRefresh = this.ctx.eventBus.subscribe(
      { category: EventCategory.StreamBrokerOnRequestStreamSourceRefresh },
      (event) => {
        const data: unknown = event.data
        const deviceId =
          typeof data === 'object' && data !== null && 'deviceId' in data ? data.deviceId : null
        if (deviceId !== this.id) return
        if (this.session === null) {
          if (this.pinAttention.blocked) {
            this.ctx.logger.debug(
              'robot camera: wake skipped — the camera PIN needs the operator',
              {
                tags: { deviceId: this.id },
              },
            )
            return
          }
          void this.openStream().catch(() => undefined)
          return
        }
        void this.publishRelay(this.session)
      },
    )
  }

  private unsubscribeRefresh: (() => void) | null = null

  /** Register the stream on the broker — the server, or the lazy sentinel (push semantics; the catalog is the durable copy). */
  /**
   * The hub's address for agents and LAN devices
   * (`local-network.getAddresses().roles.internal`: the address flagged
   * "Internal" on the Network page, else the detected LAN address). A failed
   * read is `null` — `advertisedRfcHost` then answers loopback, which this
   * node's own broker can still dial.
   */
  private async hubClusterAddress(): Promise<string | null> {
    try {
      return relayHubAddress(await this.ctx.api.localNetwork.getAddresses.query())
    } catch (err: unknown) {
      this.ctx.logger.warn('robot camera: hub address unavailable — advertising loopback', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return null
    }
  }

  private async publishRelay(session: CameraStreamSession | null): Promise<void> {
    const [descriptor] = cameraStreamCatalog(session)
    if (descriptor === undefined) return
    try {
      await this.ctx.api.streamBroker.publishCameraStream.mutate({
        deviceId: this.id,
        ...descriptor,
      })
      this.ctx.logger.info('robot camera: stream published on the broker', {
        tags: { deviceId: this.id },
        meta: { lazy: session === null },
      })
    } catch (err) {
      this.ctx.logger.warn('robot camera: publish of the relay failed', {
        tags: { deviceId: this.id },
        meta: { error: errMsg(err) },
      })
    }
  }

  private publishBattery(): void {
    const handle = this.resolveHandle()
    const vacuum = handle instanceof DreameVacuum ? handle : null
    this.setCapSlice(
      batteryCapability,
      cameraBatterySlice({
        level: vacuum?.battery ?? null,
        charging: vacuum?.charging ?? null,
        streamOpen: this.session !== null,
        now: Date.now(),
        contactAt: this.lastContactAt,
      }),
    )
  }

  private publishCatalog(): void {
    this.runtimeState.setCapState(streamCatalogCapability.name, {
      descriptors: [...cameraStreamCatalog(this.session)],
      lastFetchedAt: Date.now(),
    })
  }

  /**
   * `battery.wakeForStream`: open the monitor inside the caller's bound. An
   * open that outlives the bound keeps running — the next play joins it.
   */
  private async wakeForStream(timeoutMs: number): Promise<{ awoke: boolean; durationMs: number }> {
    const startedAt = Date.now()
    if (this.session !== null) return { awoke: true, durationMs: 0 }
    const opened = this.openStream().then(
      () => 'open' as const,
      () => 'failed' as const,
    )
    const bound = new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), timeoutMs)
      timer.unref?.()
    })
    const outcome = await Promise.race([opened, bound])
    if (outcome === 'timeout') {
      this.ctx.logger.info('robot camera: the wake outlived its bound — the open keeps running', {
        tags: { deviceId: this.id },
        meta: { timeoutMs },
      })
    }
    return { awoke: outcome === 'open', durationMs: Date.now() - startedAt }
  }

  /**
   * The PIN episode (D911): a monitor refused for want of the camera PIN needs
   * the operator, so it raises ONE critical alert and the wake stands down
   * until the PIN setting changes.
   */
  private readonly pinAttention = new PinAttention({
    deviceId: this.id,
    deviceName: () => this.name,
    emit: async (alert) => {
      const emit = this.ctx.api.alerts?.emit
      if (emit === undefined) {
        this.ctx.logger.warn('robot camera: PIN alert skipped — alerts capability missing', {
          tags: { deviceId: this.id },
        })
        return
      }
      try {
        await emit.mutate(alert)
        this.ctx.logger.warn(
          'robot camera: PIN alert raised — the wake stops until the PIN changes',
          {
            tags: { deviceId: this.id },
            meta: { alertId: alert.id, episodeKey: alert.metadata?.['episodeKey'] },
          },
        )
      } catch (err) {
        this.ctx.logger.warn('robot camera: PIN alert emit failed', {
          tags: { deviceId: this.id },
          meta: { error: errMsg(err) },
        })
      }
    },
    resolve: async (alertId) => {
      const update = this.ctx.api.alerts?.update
      if (update === undefined) return
      try {
        await update.mutate({ alertId, patch: { status: 'completed', read: true } })
        this.ctx.logger.info('robot camera: PIN alert resolved', {
          tags: { deviceId: this.id },
          meta: { alertId },
        })
      } catch (err) {
        this.ctx.logger.warn('robot camera: PIN alert resolve failed', {
          tags: { deviceId: this.id },
          meta: { alertId, error: errMsg(err) },
        })
      }
    },
  })

  private openStream(): Promise<void> {
    if (this.opening !== null) return this.opening
    if (this.pinAttention.blocked) {
      return Promise.reject(new Error('camera PIN unusable — waiting for the operator'))
    }
    const run = (async (): Promise<void> => {
      const startedAt = Date.now()
      try {
        const controller = await this.requireController()
        // nodedreame's stream speaks the relay, our TCP server frames it as
        // RTP, and the broker pulls that.
        const stream = new DreameCameraStream({
          controller,
          log: (line) => this.ctx.logger.debug(line, { tags: { deviceId: this.id } }),
        })
        const rfc = await startRfc4571Server({
          stream,
          logger: this.ctx.logger.withTags({ deviceId: this.id }),
          keyframeTimeoutMs: WAKE_TIMEOUT_MS,
          onConsumerDisconnect: () => {
            void this.closeStream('idle')
          },
          onFeedLost: (loss) => {
            this.onFeedLost(loss)
          },
        })
        this.live = { stream, rfc }
        this.session = {
          url: rfcUrl(advertisedRfcHost(await this.hubClusterAddress()), rfc.port),
          sdp: rfc.sdp,
        }
        this.sessionOpenedAt = Date.now()
        this.armMaxDuration()
        this.publishBattery()
        this.publishCatalog()
        // Tell the broker NOW, not at its next catalog reconcile: the play
        // that woke us is waiting on a registered broker.
        await this.publishRelay(this.session)
        void this.pinAttention.succeeded()
        this.ctx.logger.info('robot camera: monitor open, RTP server published', {
          tags: { deviceId: this.id },
          meta: {
            openMs: Date.now() - startedAt,
            port: rfc.port,
            audio: rfc.audio?.codec ?? 'none',
          },
        })
      } catch (err) {
        this.ctx.logger.warn('robot camera: monitor could not be opened', {
          tags: { deviceId: this.id },
          meta: { openMs: Date.now() - startedAt, error: errMsg(err) },
        })
        const code = this.config.get('navigationAccessCode')
        const refusal = classifyPinRefusal(err, code !== undefined && code !== '')
        if (refusal !== null) await this.pinAttention.refused(refusal)
        throw err
      }
    })()
    this.opening = run.finally(() => {
      this.opening = null
    })
    return this.opening
  }

  /**
   * The feed died under an open monitor. The session is closed — the lazy
   * sentinel goes back on the broker — so the broker's next dial asks for a
   * materialize, which is the wake. Logged: this branch drops a live stream.
   */
  private onFeedLost(loss: FeedLoss): void {
    this.ctx.logger.warn(
      'robot camera: relay feed lost — closing the monitor; the next dial re-opens it',
      {
        tags: { deviceId: this.id },
        meta: {
          reason: loss.reason,
          error: loss.error === null ? null : errMsg(loss.error),
          openMs: Date.now() - this.sessionOpenedAt,
        },
      },
    )
    void this.closeStream('feed-lost')
  }

  private armMaxDuration(): void {
    if (this.maxTimer !== null) clearTimeout(this.maxTimer)
    this.maxTimer = setTimeout(() => {
      this.onMaxDuration()
    }, MAX_STREAM_MS)
    this.maxTimer.unref?.()
  }

  /**
   * The duration cap fired. A viewer's session closes here as it always did.
   * A session the RECORDER holds while the robot is in function is re-armed
   * instead — the recording follows the signal, and a cap that cut it every
   * ten minutes would leave a re-open gap in every clip — up to
   * {@link MAX_STREAM_WHILE_ACTIVE_MS}, past which it closes regardless.
   */
  private onMaxDuration(): void {
    this.maxTimer = null
    const openMs = Date.now() - this.sessionOpenedAt
    if (this.recordingSignal().active && openMs < MAX_STREAM_WHILE_ACTIVE_MS) {
      this.ctx.logger.info('robot camera: duration cap re-armed — the robot is in function', {
        tags: { deviceId: this.id },
        meta: { openMs, boundMs: MAX_STREAM_WHILE_ACTIVE_MS },
      })
      this.armMaxDuration()
      return
    }
    void this.closeStream('max-duration')
  }

  private async closeStream(
    reason: 'idle' | 'keep-alive' | 'removed' | 'max-duration' | 'feed-lost',
  ): Promise<void> {
    if (this.maxTimer !== null) clearTimeout(this.maxTimer)
    this.maxTimer = null
    if (this.session === null) return
    const live = this.live
    this.session = null
    this.live = null
    this.publishBattery()
    this.publishCatalog()
    // Back to the lazy sentinel: the stream stays LISTED (the device page's
    // broker, the viewer's play disc) and the next dial asks us to
    // materialize — i.e. wake — again. A registered stream with the OLD tcp
    // url was one the next play dialled into nothing. Only a removed device
    // retracts.
    if (reason === 'removed') {
      await this.ctx.api.streamBroker.retractCameraStream
        .mutate({ deviceId: this.id, camStreamId: CAMERA_STREAM_ID })
        .catch((err: unknown) => {
          this.ctx.logger.warn('robot camera: retract of the stream failed', {
            tags: { deviceId: this.id },
            meta: { reason, error: errMsg(err) },
          })
        })
    } else {
      await this.publishRelay(null)
    }
    if (live !== null) {
      await live.rfc.close().catch(() => undefined)
      // `stop()` closes the relay AND releases the monitor.
      await live.stream.stop().catch((err: unknown) => {
        this.ctx.logger.debug('robot camera: stream stop reported an error', {
          tags: { deviceId: this.id },
          meta: { reason, error: errMsg(err) },
        })
      })
    }
    this.ctx.logger.info('robot camera: monitor closed', {
      tags: { deviceId: this.id },
      meta: { reason },
    })
  }

  private buildNavigationProvider(): InferNativeProvider<typeof navigationCapability> {
    const provider: InferNativeProvider<typeof navigationCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<NavigationRuntimeState>(CAP_NAME) ?? NAV_COLD_START,
      listActions: async () => dreameNavigationCatalog(resolveDisabledEntryIds(this.overrides())),
      getFeatures: async () => this.buildFeatures(),
      move: async ({ pan, tilt, speed }) => {
        // The UI owns the 1 Hz cadence + the first-of-gesture audio cue; the
        // provider forwards ONE drive write per call without debouncing.
        await this.dispatch(moveCall({ pan, tilt, speed }))
      },
      stop: async () => {
        await this.dispatch(stopCall())
      },
      goToPoint: async ({ x, y }) => {
        await this.dispatch(goToPointCall({ x, y }))
      },
      runAction: async ({ actionId }) => {
        await this.dispatch(actionCall(actionId))
        this.applyOptimisticAction(actionId)
      },
      playSound: async ({ soundId }) => {
        await this.dispatch(playSoundCall(soundId))
      },
      setLightOn: async ({ on }) => {
        await this.dispatch(lightOnCall(on))
        this.patchStatus({ flash: on })
      },
      setLightMode: async ({ mode, level }) => {
        await this.dispatch(lightModeCall(mode, level))
        this.patchStatus(
          mode === 'manual' && level !== undefined
            ? { lightMode: mode, lightLevel: level }
            : { lightMode: mode },
        )
      },
      setLightLevel: async ({ level }) => {
        await this.dispatch(lightLevelCall(level))
        this.patchStatus({ lightMode: 'manual', lightLevel: level })
      },
    }
    return provider
  }

  protected override recomputeSlice(): void {
    const handle = this.resolveHandle()
    if (handle === null) return
    // A state change IS contact: the broker refuses to wake a camera that has
    // been silent for hours, and this is the clock it reads.
    this.lastContactAt = Date.now()
    this.publishBattery()
    if (handle instanceof DreameVacuum) {
      this.publishRecordingSignal(mapMiotStateToVacuumState(handle.status))
    }
    const prev = this.runtimeState.getCapState<NavigationRuntimeState>(CAP_NAME) ?? NAV_COLD_START
    // `mode` is mapped from the shared vacuum lifecycle state; the light comes
    // from the robot's own properties when it reports them (a property it does
    // not report leaves the command-driven value in place); `following` stays
    // command-driven until a read-back is confirmed.
    const readback =
      handle instanceof DreameVacuum
        ? decodeNavigationReadback((siid, piid) => handle.getProperty(siid, piid)?.value)
        : {}
    // Person-follow is a robot STATE, so the shared status is its read-back.
    const following = handle instanceof DreameVacuum ? decodeFollowing(handle.status) : null
    this.runtimeState.setCapState(
      CAP_NAME,
      navigationSlice(
        prev,
        {
          ...readback,
          ...(following !== null ? { following } : {}),
          mode: following === true ? 'following' : this.deriveMode(handle),
        },
        Date.now(),
      ),
    )
  }

  /**
   * The robot's camera access code — the privacy PIN set when the camera was
   * paired. Without it `startMonitor` is refused (code -1), which is what the
   * first wake against this robot reported. Offered here because the child
   * schema carried the field and nothing showed it: a setting no surface
   * offers is a setting that does not exist.
   */
  override getSettingsUISchema(): ConfigUISchemaWithValues {
    // Kick a refresh for the NEXT open and answer from what is known now —
    // the form is built synchronously and must not block on the cloud.
    void this.refreshVendorNow()
    return hydrateSchema(
      CAMERA_SETTINGS_SCHEMA,
      cameraSettingsValues({
        accessCode: this.config.get('navigationAccessCode'),
        vendorNow: this.vendorNow,
        storedVendor: this.config.get('videoVendor'),
      }),
    )
  }

  override async applySettingsPatch(patch: Record<string, unknown>): Promise<void> {
    // WHAT ARRIVED. A save that reaches this device and does nothing looks
    // exactly like a save that never arrived, and on 2026-09-16 the two were
    // indistinguishable: the operator changed the video backend, the form sat
    // waiting, and not one line was written anywhere. Keys only — a patch can
    // carry the camera's privacy PIN.
    this.ctx.logger.info('robot camera: settings patch received', {
      tags: { deviceId: this.id },
      meta: { keys: Object.keys(patch).sort(), vendorNow: this.vendorNow },
    })
    await super.applySettingsPatch(patch)
    // A backend change is WRITTEN THROUGH to the robot, and waited on. The
    // device reports the new backend before its SDK is up, so a switch that
    // returns early hands the next play a robot that names a plane it cannot
    // yet serve.
    const wanted = patch['videoVendor']
    if ((wanted === 'ali' || wanted === 'tx') && wanted !== this.vendorNow) {
      const handle = this.resolveHandle()
      if (handle instanceof DreameVacuum) {
        await this.closeStream('removed')
        this.controller = null
        this.controllerHandle = null
        this.ctx.logger.info('robot camera: switching video backend', {
          tags: { deviceId: this.id },
          meta: { from: this.vendorNow, to: wanted },
        })
        try {
          const settled = await handle.setVideoVendor(wanted)
          this.vendorNow = settled.vendor
          this.ctx.logger.info('robot camera: video backend switched', {
            tags: { deviceId: this.id },
            meta: { vendor: settled.vendor, initStatus: settled.initStatus },
          })
        } catch (err) {
          // A refusal is the robot's answer, and it has to be audible: a switch
          // that silently does not happen leaves the operator looking at a form
          // that reverts with no reason given.
          this.ctx.logger.warn('robot camera: video backend switch refused', {
            tags: { deviceId: this.id },
            meta: { to: wanted, error: errMsg(err) },
          })
          throw err
        }
      }
    }
    if (!('navigationAccessCode' in patch)) return
    // The PIN changed: the episode is over until the next wake proves otherwise.
    await this.pinAttention.settingChanged()
    // The controller was built with the previous code; the next open must
    // not reuse it. An open monitor is closed first so the relay is released.
    await this.closeStream('removed')
    this.controller = null
    this.controllerHandle = null
  }

  private controller: Promise<DreameCameraController> | null = null
  private controllerHandle: DreameBaseDevice | null = null

  /**
   * The typed controller, built once per live handle (the build resolves the
   * cloud video profile, so it is a promise shared by every caller); rebuilt
   * if the handle changes. Never `open()`ed here.
   */
  private requireController(): Promise<DreameCameraController> {
    const handle = this.requireHandle()
    if (!(handle instanceof DreameVacuum)) {
      throw new Error('DreameCameraDevice: the robot handle is not a vacuum — no camera controller')
    }
    if (this.controller === null || this.controllerHandle !== handle) {
      const accessCode = this.config.get('navigationAccessCode')
      this.controllerHandle = handle
      this.controller = handle
        .createCameraController({
          ...(accessCode !== undefined && accessCode !== '' ? { accessCode } : {}),
          wakeTimeoutMs: WAKE_TIMEOUT_MS,
          onKeepAliveError: (err: unknown) => {
            this.ctx.logger.warn('robot camera: relay keep-alive failed — closing the monitor', {
              tags: { deviceId: this.id },
              meta: { error: errMsg(err) },
            })
            void this.closeStream('keep-alive')
          },
        })
        .catch((err: unknown) => {
          // A failed build must not be cached as the controller.
          this.controller = null
          this.controllerHandle = null
          throw err
        })
    }
    return this.controller
  }

  /** Perform a translated navigation call on the typed controller. */
  private async dispatch(call: ControllerCall): Promise<void> {
    await runControllerCall(await this.requireController(), call)
  }

  override async removeDevice(): Promise<void> {
    await super.removeDevice()
    this.networkLink.stop()
    this.unsubscribeRefresh?.()
    this.unsubscribeRefresh = null
    await this.closeStream('removed')
    const pending = this.controller
    this.controller = null
    this.controllerHandle = null
    if (pending !== null) {
      await pending.then((controller) => controller.close()).catch(() => undefined)
    }
  }

  /** Per-device general-primitive feature flags: the defaults, then this device's overrides. */
  private buildFeatures(): NavigationFeatures {
    return resolveNavigationFeatures(this.overrides())
  }

  /** This device's navigation overrides, straight from its persisted config. */
  private overrides(): {
    features?: Partial<NavigationFeatures>
    disabledEntryIds?: readonly string[]
  } {
    const features = this.config.get('navigationFeatures')
    const disabledEntryIds = this.config.get('navigationDisabledEntryIds')
    return {
      ...(features !== undefined ? { features } : {}),
      ...(disabledEntryIds !== undefined ? { disabledEntryIds } : {}),
    }
  }

  /** Map the shared vacuum lifecycle state to a coarse navigation mode. */
  private deriveMode(handle: DreameBaseDevice): NavigationStatus['mode'] {
    if (!(handle instanceof DreameVacuum)) return 'unknown'
    switch (mapMiotStateToVacuumState(handle.status)) {
      case 'cleaning':
        return 'cleaning'
      case 'paused':
        return 'paused'
      case 'returning':
        return 'returning'
      case 'idle':
      case 'docked':
      case 'drying':
        return 'idle'
      default:
        return 'unknown'
    }
  }

  /**
   * Optimistically reflect a just-issued action in the status slice so the UI
   * updates immediately (there is no confirmed read-back yet).
   */
  private applyOptimisticAction(actionId: Parameters<typeof actionCall>[0]): void {
    switch (actionId) {
      case 'flashOn':
        this.patchStatus({ flash: true })
        return
      case 'flashOff':
        this.patchStatus({ flash: false })
        return
      case 'personFollow':
        this.patchStatus({ following: true, mode: 'following' })
        return
      case 'stop':
        this.patchStatus({ following: false })
        return
      default:
        return
    }
  }

  /**
   * Merge a patch into the status slice. Written THROUGH `runtimeState` — never a
   * parallel private cache (CLAUDE.md).
   */
  private patchStatus(patch: Partial<NavigationStatus>): void {
    const prev = this.runtimeState.getCapState<NavigationRuntimeState>(CAP_NAME) ?? NAV_COLD_START
    this.runtimeState.setCapState(CAP_NAME, navigationSlice(prev, patch, Date.now()))
  }
}
