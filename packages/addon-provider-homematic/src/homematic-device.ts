import { buildDeviceAdminUrl, deviceAdminLinkCapability } from '@camstack/types'
import { z } from 'zod'
import {
  BaseDevice,
  DeviceType,
  EventCategory,
  climateControlCapability,
  coverCapability,
  createEvent,
  eventEmitterCapability,
  lockControlCapability,
  motionCapability,
  switchCapability,
  type ClimateControlStatus,
  type CoverStatus,
  type DeviceContext,
  type DeviceFeature,
  type EventEmitterStatus,
  type EventFire,
  type HvacMode,
  type InferNativeProvider,
  type LockControlStatus,
  type MotionStatus,
  type PowerMeterStatus,
  type SwitchStatus,
} from '@camstack/types'
import type {
  Homematic,
  HmChannel,
  HmCustomEntity,
  HmDevice,
  ValueChangedEvent,
} from 'nodehomematic'
import { coldMotionKeepingRise } from './devices/hm-cold-start.js'
import { homematicFacades } from './homematic-gateway.js'
import { mapHmDeviceChannels } from './homematic-mapping.js'
import { decodeClimate, decodeCover, decodeLock, toHmClimateMode } from './homematic-decode.js'
import {
  registerAmbientLightCap,
  registerHumidityCap,
  registerPowerMeterCap,
  registerTemperatureCap,
} from './homematic-sensor-caps.js'

/**
 * Persisted config every Homematic-backed device carries. `address` is
 * the CCU device address (e.g. `0001D3C99AB123`) — the dispatch key the
 * device uses to resolve its live `HmDevice` from the facade and to
 * filter inbound `valueChanged` events to its own datapoints.
 */
export const homematicDeviceSchema = z.object({
  address: z.string().min(1).describe('CCU device address'),
  /** The registry broker id this device belongs to (e.g. `hm_001`).
   *  Absent on devices persisted before the multi-CCU migration; those
   *  fall back to the primary broker via `homematicFacades.get(null)`. */
  brokerId: z.string().optional(),
})

export type HomematicDeviceConfig = z.infer<typeof homematicDeviceSchema>

/** Cold-start defaults so reads never miss a slice before the first push. */
const COLD_SWITCH: SwitchStatus = { on: false, lastChangedAt: 0 }
const COLD_COVER: CoverStatus = {
  state: 'closed',
  position: null,
  tiltPosition: null,
  lastChangedAt: 0,
}
const COLD_LOCK: LockControlStatus = { state: 'unlocked', lastChangedAt: 0 }
const COLD_MOTION: MotionStatus = { detected: false, lastDetectedAt: null, autoClearAfterMs: null }
const CLIMATE_MODES: readonly HvacMode[] = ['off', 'heat', 'auto']
const COLD_CLIMATE: ClimateControlStatus = {
  mode: 'auto',
  availableModes: [...CLIMATE_MODES],
  fanMode: '',
  availableFanModes: [],
  preset: '',
  availablePresets: ['boost'],
  target: null,
  targetHigh: null,
  targetLow: null,
  targetHumidity: null,
  currentTemp: null,
  currentHumidity: null,
  swingVertical: null,
  swingHorizontal: null,
  lastFetchedAt: 0,
}

/**
 * The standard HmIP key-channel datapoint vocabulary, used VERBATIM (NO
 * normalization) as the `event-emitter` event types. These are the native
 * uppercase tokens a `KEY_TRANSCEIVER` / `KEY_TRANSMITTER` / `VIRTUAL_KEY`
 * / `KEY` channel emits on the facade `valueChanged` stream (via HA they
 * surface lowercased as `press_short` etc.; natively they are uppercase):
 *   - PRESS_SHORT         single short press
 *   - PRESS_LONG          long press (repeats while held on some firmware)
 *   - PRESS_LONG_START    long-press begin
 *   - PRESS_LONG_RELEASE  long-press end
 *   - PRESS_CONT          continuous-press tick while held
 * Used both as the seed vocabulary fallback and as the fire-detection set
 * (a non-key datapoint such as a maintenance LOW_BAT is ignored).
 */
const HM_KEY_PRESS_DATAPOINTS: readonly string[] = [
  'PRESS_SHORT',
  'PRESS_LONG',
  'PRESS_LONG_START',
  'PRESS_LONG_RELEASE',
  'PRESS_CONT',
] as const

/** Set form for O(1) fire-detection membership tests. */
const HM_KEY_PRESS_SET: ReadonlySet<string> = new Set(HM_KEY_PRESS_DATAPOINTS)

/** Cold-start event-emitter slice; vocabulary supplied per-device. */
function coldEventEmitter(eventTypes: readonly string[]): EventEmitterStatus {
  return { eventTypes: [...eventTypes], lastEvent: null, eventCountSinceStart: 0 }
}

/**
 * Collect the union of native `PRESS_*` datapoints a device's key channels
 * support, VERBATIM. Reads each key channel's `dataPoints` (when the
 * facade enumerated them) and keeps only the recognised press tokens. Falls
 * back to the standard HmIP key vocabulary when no datapoints were
 * enumerated, so the cap always advertises a non-empty vocabulary.
 */
function keyEventVocabulary(keyChannels: readonly HmChannel[]): readonly string[] {
  const found = new Set<string>()
  for (const channel of keyChannels) {
    for (const dp of channel.dataPoints ?? []) {
      if (HM_KEY_PRESS_SET.has(dp.parameter)) found.add(dp.parameter)
    }
  }
  // Preserve the canonical order; fall back to the full standard set when
  // the facade didn't enumerate any datapoints for the key channels.
  if (found.size === 0) return HM_KEY_PRESS_DATAPOINTS
  return HM_KEY_PRESS_DATAPOINTS.filter((dp) => found.has(dp))
}

/**
 * The CamStack cap names that are ACTUATORS — driven by the library's typed
 * custom entities (correct channel), NOT by the raw mapped channels. The
 * raw-channel registration loop skips these so they are not double-registered
 * against the wrong channel.
 */
const ACTUATOR_CAP_NAMES: ReadonlySet<string> = new Set([
  'switch',
  'cover',
  'light',
  'lock-control',
  'climate-control',
])

/**
 * Map a `nodehomematic` custom-entity `kind` to its CamStack actuator cap
 * name. The union is discriminated by `kind`; the exhaustive switch needs no
 * cast. Returns `null` for kinds with no actuator cap wired yet.
 */
function actuatorCapForEntityKind(kind: HmCustomEntity['kind']): string | null {
  switch (kind) {
    case 'switch':
      return 'switch'
    case 'cover':
    case 'blind':
      return 'cover'
    case 'light':
      return 'light'
    case 'lock':
      return 'lock-control'
    case 'climate':
      return 'climate-control'
    default:
      return null
  }
}

/** Parse the numeric channel index suffix (`:N`) from a channel address.
 *  Returns the raw suffix string (kept as a string for the event payload,
 *  mirroring the CCU's `device:index` addressing). Null when absent. */
function channelIndexFromAddress(channelAddress: string): string | null {
  const idx = channelAddress.lastIndexOf(':')
  if (idx === -1) return null
  const suffix = channelAddress.slice(idx + 1)
  return suffix.length > 0 ? suffix : null
}

/**
 * One CamStack device per Homematic device. Maps the device's channels to
 * CamStack caps (via `homematic-mapping.ts`) and wires each cap's
 * get/set surface to the `nodehomematic` facade's typed helpers
 * (`switchTurnOn` / `coverSetPosition` / `climateSetTemperature` /
 * `lockLock`) and raw `getValue`/`setValue` for read-only sensors.
 *
 * Status flows back via the facade `valueChanged` stream: each push is
 * decoded by parameter name into the relevant cap's runtime-state slice
 * (see `homematic-decode.ts` for the pure decoders).
 *
 * MAPPED (control + status):
 *   - switch          (HmIP-BSM / BS2)
 *   - cover           (HmIP-BROLL)
 *   - climate-control (HmIP-eTRV-C / BWTH / STHD / WTH-2 / HEATING)
 *   - lock-control    (HmIP-DLD)
 * MAPPED (read-only sensors):
 *   - temperature-sensor / humidity-sensor (climate channels)
 *   - motion + ambient-light-sensor        (HmIP-SMI)
 *   - power-meter                          (HmIP-BSM / ESI energy)
 * MAPPED (push-only events):
 *   - event-emitter   (HmIP-WRC* wall switches / HmIP-RC* remotes / key
 *                      channels) — one singleton cap over all key channels;
 *                      native PRESS_* datapoints fired verbatim with the
 *                      button index in `data.channel`.
 */
export class HomematicDevice extends BaseDevice<typeof homematicDeviceSchema> {
  readonly features: readonly DeviceFeature[] = []

  /** CCU device address — dispatch + event-filter key. */
  protected readonly address: string

  /**
   * Registry broker id this device belongs to. Undefined for devices
   * persisted before the multi-CCU migration; those resolve to the primary
   * broker via `homematicFacades.get(null)`.
   */
  protected readonly brokerId: string | undefined

  /** Unsubscribe for the facade `valueChanged` listener. */
  private valueChangedUnsub: (() => void) | null = null

  /** Channel address that owns each registered cap (for decode routing). */
  private readonly capChannels = new Map<string, string>()

  /** Native press-datapoint vocabulary for this device's key channels
   *  (verbatim, NO normalization). Empty when the device has no key
   *  channel — gates the `event-emitter` fire path. */
  private eventTypes: readonly string[] = []

  /** Monotonic event sequence — two identical presses still produce
   *  distinct slice writes / bus emissions. */
  #eventSeq = 0

  /** Count of key presses observed since this device instance started. */
  #eventCount = 0

  constructor(ctx: DeviceContext) {
    const persisted = (ctx.persistedConfig ?? {}) as Partial<HomematicDeviceConfig>
    const address = persisted.address
    if (typeof address !== 'string' || address.length === 0) {
      throw new Error(`HomematicDevice: missing address in persisted config (id=${ctx.id})`)
    }
    super(ctx, homematicDeviceSchema, { type: ctx.deviceMeta.type })
    this.address = address
    // brokerId absent = legacy device persisted before multi-CCU support;
    // falls back to the primary broker in get facade().
    this.brokerId = typeof persisted.brokerId === 'string' ? persisted.brokerId : undefined

    this.registerAdminLinkCap()
    this.registerCapabilities()
    this.attachValueChangedListener()

    void this.updateSourceInfo({ id: this.address, system: 'homematic' })
  }

  /** The live facade for this device's CCU, or null when disconnected. */
  protected get facade(): Homematic | null {
    return homematicFacades.get(this.brokerId ?? null)
  }

  /** Resolve this device's current `HmDevice` snapshot from the facade. */
  protected resolveHmDevice(): HmDevice | null {
    const facade = this.facade
    if (!facade) return null
    return facade.devices().find((d) => d.address === this.address) ?? null
  }

  // ── Capability registration ──────────────────────────────────────────

  /**
   * device-admin-link — a Homematic device has no web server; the CCU3 /
   * RaspberryMatic WebUI is where it is configured. The CCU has no stable
   * per-device deep link (the WebUI addresses devices through a session-bound
   * frameset), so every device on a CCU gets that CCU's root, labelled for
   * what it is. A device persisted before multi-CCU support carries no
   * `brokerId` and cannot be attributed to a CCU at all — it answers null.
   *
   * Registered OUTSIDE `registerCapabilities`, which returns early when the
   * facade has not yet seen the device: whether the CCU has a WebUI does not
   * depend on that, and an early return there used to be how a device ended up
   * with no caps at all.
   */
  private registerAdminLinkCap(): void {
    const brokerId = this.brokerId
    const provider: InferNativeProvider<typeof deviceAdminLinkCapability> = {
      getAdminLink: async ({ deviceId }) => {
        if (deviceId !== this.id) {
          throw new Error(
            `HomematicDevice: deviceId mismatch, expected ${this.id}, got ${deviceId}`,
          )
        }
        if (brokerId === undefined) {
          this.ctx.logger.debug('homematic admin link unavailable: no brokerId on device', {
            tags: { deviceId: this.id },
            meta: { address: this.address },
          })
          return null
        }
        const cfg = await this.ctx.api.broker.getBrokerConfig.query({ id: brokerId })
        const host = typeof cfg?.['host'] === 'string' ? cfg['host'] : ''
        const tls = cfg?.['tls'] === true
        const built = buildDeviceAdminUrl({
          host,
          port: null,
          scheme: tls ? 'https' : 'http',
          path: '/',
        })
        if (!built.ok) {
          this.ctx.logger.debug('homematic admin link unavailable', {
            tags: { deviceId: this.id },
            meta: { reason: built.reason, brokerId },
          })
          return null
        }
        return { url: built.url, label: 'CCU WebUI', target: 'integration' as const, host }
      },
    }
    this.ctx.registerNativeCap(deviceAdminLinkCapability, provider)
  }

  private registerCapabilities(): void {
    const hmDevice = this.resolveHmDevice()
    if (!hmDevice) {
      this.ctx.logger.warn('HomematicDevice: device not found on facade at construction', {
        meta: { address: this.address },
      })
      return
    }

    // ── Actuator caps come from the library's typed custom entities ──────
    // The lib binds ONE typed entity (HmCover / HmSwitch / …) per device on
    // a SPECIFIC channel and its control helpers (`coverOpen(device, channel)`,
    // `switchTurnOn(device, channel)`, …) require THAT channel. A cover device
    // has several `SHUTTER_VIRTUAL_RECEIVER` channels (:4/:5/:6); binding the
    // cap to a raw mapped channel (the last one) makes control throw
    // "No cover custom entity for … :N". So we register actuator caps from
    // `customEntities()` using `entity.channel`, NOT from the raw channels.
    this.registerActuatorCapsFromCustomEntities()

    // ── Sensor + event-emitter caps come from the raw mapped channels ────
    // These are NOT custom entities: read-only sensors (temperature /
    // humidity / motion / ambient-light / power-meter) and the singleton
    // `event-emitter` over the device's key channels. We SKIP the actuator
    // cap kinds here — they are handled above via the custom entities and
    // must not be double-registered against the wrong channel.
    const keyChannels: HmChannel[] = []
    for (const { channel, mapping } of mapHmDeviceChannels(hmDevice)) {
      for (const capName of mapping.capabilities) {
        if (capName === 'event-emitter') {
          keyChannels.push(channel)
          continue
        }
        if (ACTUATOR_CAP_NAMES.has(capName)) continue
        this.registerCap(capName, channel.address)
      }
    }
    if (keyChannels.length > 0) this.registerEventEmitterCap(keyChannels)
  }

  /**
   * Register the device's ACTUATOR caps (switch / cover / light / lock /
   * climate-control) from the library's typed custom entities. Each
   * `HmCustomEntity` carries the EXACT channel the lib bound the entity to —
   * the channel the facade control helpers require. The cap channel stored in
   * `capChannels` is therefore the custom-entity channel, so `coverOpen`
   * (etc.) dispatch to the correct one.
   *
   * When `customEntities()` is empty (facade not fully built yet at
   * construction time), this is a no-op beyond a debug note; the actuator
   * caps register on the next reconcile/re-probe once the entities exist.
   */
  private registerActuatorCapsFromCustomEntities(): void {
    const entities = this.facade?.customEntities()?.filter((e) => e.device === this.address) ?? []
    if (entities.length === 0) {
      this.ctx.logger.debug(
        'HomematicDevice: no custom entities at registration; actuator caps deferred to next reconcile',
        { meta: { address: this.address } },
      )
      return
    }
    for (const entity of entities) {
      const capName = actuatorCapForEntityKind(entity.kind)
      if (capName === null) continue
      this.registerCap(capName, entity.channel)
    }
  }

  /** Dispatch one cap registration to its concrete wiring. */
  private registerCap(capName: string, channelAddress: string): void {
    this.capChannels.set(capName, channelAddress)
    switch (capName) {
      case 'switch':
        return this.registerSwitchCap(channelAddress)
      case 'cover':
        return this.registerCoverCap(channelAddress)
      case 'climate-control':
        return this.registerClimateCap(channelAddress)
      case 'lock-control':
        return this.registerLockCap(channelAddress)
      case 'motion':
        return this.registerMotionCap()
      case 'ambient-light-sensor':
        return registerAmbientLightCap(this.ctx, this.runtimeState)
      case 'temperature-sensor':
        return registerTemperatureCap(this.ctx, this.runtimeState)
      case 'humidity-sensor':
        return registerHumidityCap(this.ctx, this.runtimeState)
      case 'power-meter':
        return registerPowerMeterCap(this.ctx, this.runtimeState)
      default:
        this.ctx.logger.debug('HomematicDevice: cap not yet wired', {
          meta: { capName, channelAddress, address: this.address },
        })
        return
    }
  }

  // ── switch ───────────────────────────────────────────────────────────

  private registerSwitchCap(channelAddress: string): void {
    const provider: InferNativeProvider<typeof switchCapability> = {
      getStatus: async () => this.runtimeState.getCapState<SwitchStatus>('switch') ?? COLD_SWITCH,
      setState: async ({ on }) => {
        const facade = this.requireFacade()
        if (on) await facade.switchTurnOn(this.address, channelAddress)
        else await facade.switchTurnOff(this.address, channelAddress)
      },
    }
    this.ctx.registerNativeCap(switchCapability, provider)
    // Seed cold-start defaults AFTER registerNativeCap so the schema is
    // installed by the kernel context factory before the first write.
    this.runtimeState.setCapState('switch', COLD_SWITCH)
  }

  // ── cover ────────────────────────────────────────────────────────────

  private registerCoverCap(channelAddress: string): void {
    const provider: InferNativeProvider<typeof coverCapability> = {
      getStatus: async () => this.runtimeState.getCapState<CoverStatus>('cover') ?? COLD_COVER,
      open: async () => {
        await this.requireFacade().coverOpen(this.address, channelAddress)
      },
      close: async () => {
        await this.requireFacade().coverClose(this.address, channelAddress)
      },
      stop: async () => {
        await this.requireFacade().coverStop(this.address, channelAddress)
      },
      setPosition: async ({ position }) => {
        await this.requireFacade().coverSetPosition(this.address, channelAddress, position)
      },
      // HmIP-BROLL roller shutters have no slat tilt; no facade helper.
      setTiltPosition: async () => this.unsupported('cover tilt'),
    }
    this.ctx.registerNativeCap(coverCapability, provider)
    // Seed cold-start defaults AFTER registerNativeCap so the schema is
    // installed by the kernel context factory before the first write.
    this.runtimeState.setCapState('cover', COLD_COVER)
  }

  // ── climate-control ──────────────────────────────────────────────────

  private registerClimateCap(channelAddress: string): void {
    const provider: InferNativeProvider<typeof climateControlCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<ClimateControlStatus>('climate-control') ?? COLD_CLIMATE,
      setMode: async ({ mode }) => {
        await this.requireFacade().climateSetMode(
          this.address,
          channelAddress,
          toHmClimateMode(mode),
        )
      },
      setTarget: async ({ target }) => {
        await this.requireFacade().climateSetTemperature(this.address, channelAddress, target)
      },
      setPreset: async ({ preset }) => {
        await this.requireFacade().climateSetBoost(this.address, channelAddress, preset === 'boost')
      },
      // HmIP thermostats have no fan surface, are single-setpoint (no
      // heat_cool range) and do not control humidity — reject loudly.
      setFanMode: async () => this.unsupported('climate fan mode'),
      setTargetRange: async () => this.unsupported('climate dual setpoint'),
      setTargetHumidity: async () => this.unsupported('climate humidity control'),
      setSwingVertical: async () => this.unsupported('climate vertical swing'),
      setSwingHorizontal: async () => this.unsupported('climate horizontal swing'),
    }
    this.ctx.registerNativeCap(climateControlCapability, provider)
    // Seed cold-start defaults AFTER registerNativeCap so the schema is
    // installed by the kernel context factory before the first write.
    this.runtimeState.setCapState('climate-control', COLD_CLIMATE)
  }

  // ── lock-control ─────────────────────────────────────────────────────

  private registerLockCap(channelAddress: string): void {
    const provider: InferNativeProvider<typeof lockControlCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<LockControlStatus>('lock-control') ?? COLD_LOCK,
      lock: async () => {
        await this.requireFacade().lockLock(this.address, channelAddress)
      },
      unlock: async () => {
        await this.requireFacade().lockUnlock(this.address, channelAddress)
      },
      open: async () => {
        await this.requireFacade().lockOpen(this.address, channelAddress)
      },
    }
    this.ctx.registerNativeCap(lockControlCapability, provider)
    // Seed cold-start defaults AFTER registerNativeCap so the schema is
    // installed by the kernel context factory before the first write.
    this.runtimeState.setCapState('lock-control', COLD_LOCK)
  }

  // ── motion (push-only; seed slice, update via valueChanged) ──────────
  // The remaining read-only sensor caps (temperature / humidity /
  // ambient-light / power-meter) are registered via `homematic-sensor-caps.ts`.

  private registerMotionCap(): void {
    const provider: InferNativeProvider<typeof motionCapability> = {
      getStatus: async () => this.runtimeState.getCapState<MotionStatus>('motion') ?? COLD_MOTION,
      isDetected: async () =>
        (this.runtimeState.getCapState<MotionStatus>('motion') ?? COLD_MOTION).detected,
    }
    this.ctx.registerNativeCap(motionCapability, provider)
    // Seed cold-start defaults AFTER registerNativeCap so the schema is
    // installed by the kernel context factory before the first write.
    // A stored rise survives (`coldMotionKeepingRise`); the level does not.
    this.runtimeState.setCapState(
      'motion',
      coldMotionKeepingRise(this.runtimeState.getCapState<MotionStatus>('motion')),
    )
  }

  // ── event-emitter (key / remote channels — push-only) ────────────────
  // A wall switch / remote with N key channels collapses to ONE
  // event-emitter cap (singleton). The event vocabulary is the union of
  // the native `PRESS_*` datapoints the key channels support, VERBATIM
  // (no normalization). Presses are decoded in `handleValueChanged`; the
  // button index travels in the fired event's `data.channel`.

  private registerEventEmitterCap(keyChannels: readonly HmChannel[]): void {
    this.eventTypes = keyEventVocabulary(keyChannels)
    const provider: InferNativeProvider<typeof eventEmitterCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<EventEmitterStatus>('event-emitter') ??
        coldEventEmitter(this.eventTypes),
    }
    // registerNativeCap BEFORE setCapState so the cap's runtime-state
    // schema is installed by the kernel context factory before the seed.
    this.ctx.registerNativeCap(eventEmitterCapability, provider)
    this.runtimeState.setCapState('event-emitter', coldEventEmitter(this.eventTypes))
  }

  // ── Value-change wiring ──────────────────────────────────────────────

  private attachValueChangedListener(): void {
    const facade = this.facade
    if (!facade) return
    this.valueChangedUnsub = facade.on('valueChanged', (event) => {
      if (event.device !== this.address) return
      this.handleValueChanged(event)
    })
  }

  /**
   * Translate an inbound facade `valueChanged` into the relevant cap
   * slice, keyed by parameter name. Only updates caps the device
   * actually registered (`capChannels`).
   */
  private handleValueChanged(event: ValueChangedEvent): void {
    const now = event.ts || Date.now()
    const { parameter, value } = event

    if (this.capChannels.has('switch') && parameter === 'STATE' && typeof value === 'boolean') {
      this.runtimeState.setCapState('switch', { on: value, lastChangedAt: now })
    }
    if (this.capChannels.has('cover')) {
      const prev = this.runtimeState.getCapState<CoverStatus>('cover') ?? COLD_COVER
      const next = decodeCover(prev, parameter, value, now)
      if (next) this.runtimeState.setCapState('cover', next)
    }
    if (this.capChannels.has('lock-control')) {
      const next = decodeLock(parameter, value, now)
      if (next) this.runtimeState.setCapState('lock-control', next)
    }
    if (this.capChannels.has('climate-control')) {
      const prev =
        this.runtimeState.getCapState<ClimateControlStatus>('climate-control') ?? COLD_CLIMATE
      const next = decodeClimate(prev, parameter, value, now)
      if (next) this.runtimeState.setCapState('climate-control', next)
    }
    if (this.capChannels.has('motion') && parameter === 'MOTION' && typeof value === 'boolean') {
      this.runtimeState.setCapState('motion', {
        detected: value,
        lastDetectedAt: value
          ? now
          : (this.runtimeState.getCapState<MotionStatus>('motion')?.lastDetectedAt ?? null),
        autoClearAfterMs: null,
      })
    }
    if (this.eventTypes.length > 0) this.decodeKeyPress(event, now)
    this.decodeSensorPush(parameter, value, now)
  }

  /**
   * Translate a key-channel `PRESS_*` datapoint into an `EventFire`: emit
   * `EventCategory.EventEmitted` on the bus and write the `event-emitter`
   * slice. The `eventType` is the native datapoint name VERBATIM (no
   * normalization); the button index (`:N` suffix of the channel address)
   * travels in `data.channel`. Non-key datapoints and value resets (the
   * key datapoint dropping back to `false`) are ignored.
   */
  private decodeKeyPress(event: ValueChangedEvent, now: number): void {
    const { parameter, value, channel } = event
    if (!HM_KEY_PRESS_SET.has(parameter)) return
    // A press is the datapoint asserting; the matching reset (value false)
    // is not a new press. ACTION-style key datapoints also carry boolean
    // true on press — only act on the assert edge.
    if (typeof value === 'boolean' && value === false) return

    const channelIndex = channelIndexFromAddress(channel)
    const fire: EventFire = {
      deviceId: this.id,
      eventType: parameter, // native datapoint name — VERBATIM
      data: channelIndex !== null ? { channel: channelIndex } : {},
      timestamp: now,
      seq: ++this.#eventSeq,
    }

    this.ctx.eventBus.emit(
      createEvent(
        EventCategory.EventEmitted,
        {
          type: 'device',
          id: this.stableId,
          deviceId: this.id,
          addonId: this.ctx.deviceMeta.addonId,
        },
        fire,
      ),
    )

    const slice: EventEmitterStatus = {
      eventTypes: [...this.eventTypes],
      lastEvent: fire,
      eventCountSinceStart: ++this.#eventCount,
    }
    this.runtimeState.setCapState('event-emitter', slice)
  }

  /** Decode read-only sensor pushes into their slices. */
  private decodeSensorPush(parameter: string, value: unknown, now: number): void {
    if (typeof value !== 'number') return
    if (this.capChannels.has('temperature-sensor') && parameter === 'ACTUAL_TEMPERATURE') {
      this.runtimeState.setCapState('temperature-sensor', { celsius: value, lastFetchedAt: now })
    }
    if (this.capChannels.has('humidity-sensor') && parameter === 'HUMIDITY') {
      this.runtimeState.setCapState('humidity-sensor', { percent: value, lastFetchedAt: now })
    }
    if (this.capChannels.has('ambient-light-sensor') && parameter === 'ILLUMINATION') {
      this.runtimeState.setCapState('ambient-light-sensor', {
        lux: Math.max(0, value),
        lastFetchedAt: now,
      })
    }
    this.decodePowerPush(parameter, value, now)
  }

  /** Decode HmIP energy-meter parameters into the power-meter slice. */
  private decodePowerPush(parameter: string, value: number, now: number): void {
    if (!this.capChannels.has('power-meter')) return
    const prev = this.runtimeState.getCapState<PowerMeterStatus>('power-meter') ?? {
      lastFetchedAt: 0,
    }
    switch (parameter) {
      case 'POWER':
        this.runtimeState.setCapState('power-meter', { ...prev, watts: value, lastFetchedAt: now })
        return
      case 'ENERGY_COUNTER':
        // HmIP ENERGY_COUNTER is in Wh — normalise to kWh.
        this.runtimeState.setCapState('power-meter', {
          ...prev,
          kwhTotal: value / 1000,
          lastFetchedAt: now,
        })
        return
      case 'VOLTAGE':
        this.runtimeState.setCapState('power-meter', { ...prev, volts: value, lastFetchedAt: now })
        return
      case 'CURRENT':
        // HmIP CURRENT is in mA — normalise to A.
        this.runtimeState.setCapState('power-meter', {
          ...prev,
          amps: value / 1000,
          lastFetchedAt: now,
        })
        return
      default:
        return
    }
  }

  /** Reject an operation the underlying HmIP hardware does not support. */
  private unsupported(surface: string): never {
    throw new Error(`HomematicDevice: ${surface} not supported (address=${this.address})`)
  }

  /** Narrow the optional facade to a present one or throw a clear error. */
  private requireFacade(): Homematic {
    const facade = this.facade
    if (!facade) {
      throw new Error(`HomematicDevice: CCU connection unavailable (address=${this.address})`)
    }
    return facade
  }

  override async removeDevice(): Promise<void> {
    if (this.valueChangedUnsub) {
      try {
        this.valueChangedUnsub()
      } catch {
        // best-effort — device is being torn down regardless
      }
      this.valueChangedUnsub = null
    }
  }
}

/**
 * Device types this provider materialises. The legacy flat `HomematicDevice`
 * covers Switch / Cover / Thermostat / Lock / Sensor / EventEmitter / Generic;
 * the new accessory-children model adds a `Container` parent + an `Update`
 * firmware child (the other child types reuse the existing entries).
 */
export const HOMEMATIC_DEVICE_TYPES: readonly DeviceType[] = [
  DeviceType.Container,
  DeviceType.Switch,
  DeviceType.Cover,
  DeviceType.Thermostat,
  DeviceType.Lock,
  DeviceType.Sensor,
  DeviceType.EventEmitter,
  DeviceType.Update,
  DeviceType.Generic,
]
