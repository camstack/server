/**
 * LWA Event Gateway client for Alexa proactive events.
 *
 * Today the only proactive event we emit is `DoorbellEventSource/
 * DoorbellPress`, fired whenever a child device with role `doorbell`
 * pushes a press through the kernel's event bus.
 *
 * Flow (per linked Alexa account):
 *   1. Subscribe to `EventCategory.DoorbellOnPressed` once at boot.
 *   2. On each event, look up the parent camera (the doorbell button is
 *      always a child accessory of a camstack camera) and check it's
 *      exposed.
 *   3. For each linked Alexa account, POST a `DoorbellEventSource/
 *      DoorbellPress` payload to `api.amazonalexa.com/v3/events`.
 *   4. On 401, ask the skill's token broker for a fresh access token and
 *      retry once.
 *
 * This hub holds NO Login With Amazon client secret (D753). The skill's
 * Lambda exchanges the AcceptGrant code, keeps the refresh token and the
 * secret, and hands this hub short-lived access tokens against a per-link
 * credential (`broker-client.ts`). A grant delivered by a pre-D753 Lambda
 * (with a refresh token) cannot be renewed here; it is migrated to the broker
 * as soon as the broker's URL is known, and the refresh token is deleted.
 * When no grant is stored we log + skip without erroring.
 *
 * Throttling: Alexa requires at most one DoorbellPress per endpoint
 * every 30s. We enforce this per (userId, endpointId) tuple in-memory.
 */
import { randomUUID } from 'node:crypto'
import { type AddonContext, EventCategory, type IScopedLogger } from '@camstack/types'

import { endpointAccessTarget } from './access/access-gate.js'
import {
  BrokerError,
  type FetchLike,
  fetchBrokerAccessToken,
  migrateLegacyGrant,
  normaliseBrokerUrl,
} from './broker-client.js'
import { readConnectivity } from './connectivity.js'
import { signatureEntries } from './endpoint-signature.js'
import type { AlexaEndpoint } from './endpoints/types.js'
import { type AsyncResponseInput, buildAsyncResponsePayload } from './handlers/deferred-response.js'
import { parseCameraEndpointId } from './handlers/endpoint-id.js'
import { DEFAULT_MOTION_CLEAR_HOLD_MS, MotionClearHold } from './motion-clear-hold.js'
import {
  ConcurrencyLimiter,
  GATEWAY_PUSH_CONCURRENCY,
} from './state-reports/concurrency-limiter.js'
import type { StateReport } from './state-reports/state-change-map.js'
import {
  type ExposedDeviceEntry,
  isBrokerGrant,
  type LinkedAccount,
  type LwaTokenEntry,
  type UpsertLwaTokenInput,
} from './types.js'

// ── Event gateway URLs by region ────────────────────────────────────
//
// The skill's LWA token issuer claim tells us which region's gateway
// to use. Alexa rejects events posted to the wrong region's URL.

const EVENT_GATEWAY_URLS = {
  NA: 'https://api.amazonalexa.com/v3/events',
  EU: 'https://api.eu.amazonalexa.com/v3/events',
  FE: 'https://api.fe.amazonalexa.com/v3/events',
} as const

type RegionCode = keyof typeof EVENT_GATEWAY_URLS

const THROTTLE_WINDOW_MS = 30_000
const REFRESH_PROACTIVE_WINDOW_MS = 5 * 60 * 1000
const REFRESH_SCAN_INTERVAL_MS = 60 * 1000
/** After a failed legacy-grant migration, wait this long before trying again. */
const MIGRATION_RETRY_MS = 5 * 60 * 1000

/** Object-literal type (not an interface) so it satisfies the action
 *  handler's `Record<string, unknown>` return contract. */
export type DiscoverySyncResult = {
  /** Endpoints reported in the AddOrUpdateReport (0 if nothing to sync). */
  readonly endpointCount: number
  /** Linked Alexa accounts the report was sent to. */
  readonly accountCount: number
}

/** Outcome of a manual `DeleteReport` for operator-typed endpoint ids. */
export type PurgeEndpointsResult = {
  /** Number of endpoint ids the operator asked to remove. */
  readonly requested: number
  /** Linked Alexa accounts. */
  readonly accountCount: number
  /** Accounts whose Event Gateway accepted the DeleteReport (2xx). */
  readonly deliveredAccounts: number
  /** Accounts the delete did not reach: refused, or no push grant stored. */
  readonly failedAccounts: number
}

export interface LwaEventGatewayDeps {
  readonly ctx: AddonContext
  readonly logger: IScopedLogger
  readonly listExposed: () => readonly ExposedDeviceEntry[]
  readonly listLinkedAccounts: () => readonly LinkedAccount[]
  readonly listTokens: () => readonly LwaTokenEntry[]
  readonly upsertToken: (input: UpsertLwaTokenInput) => Promise<void>
  /** Remove a revoked account's token + linked-account record (403 from gateway). */
  readonly removeLinkedAccount: (userId: string) => Promise<void>
  /**
   * The broker origin the skill's Lambda advertised on the last verified
   * directive (`x-camstack-broker`), or null. Used ONLY to migrate a pre-D753
   * grant; a broker grant carries its own `brokerUrl`.
   */
  readonly getAdvertisedBrokerUrl: () => string | null
  /** This hub's public URL — informational, sent along with a migration. */
  readonly getPublicHubUrl?: () => string
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: FetchLike
  /** Region the operator selected for the skill (default NA). */
  readonly getRegion: () => RegionCode
  /**
   * The endpoint SHAPE last pushed to Alexa for a device (`exportedSignatures`),
   * or null when nothing was ever recorded. Read on the doorbell path for ONE
   * reason: to say out loud when we are about to push a `DoorbellPress` at an
   * endpoint whose discovered capabilities do not declare
   * `Alexa.DoorbellEventSource`. The gateway answers 2xx either way and the
   * cloud drops the event — the only difference is whether the log admits it.
   */
  readonly getExportedSignature: (deviceId: number) => string | null
  /**
   * Whether the hub user behind a linked Alexa account may VIEW this device
   * (S1, D767). Synchronous: it reads the visibility mirror, which is refreshed
   * off the event path (D49). An account it does not know is refused.
   */
  readonly accountMaySee: (userId: string, deviceId: number) => boolean
}

/** The interface a camera endpoint must declare for a connectivity
 *  ChangeReport to mean anything to the Alexa cloud. */
const ENDPOINT_HEALTH_INTERFACE = 'Alexa.EndpointHealth'

/** Whether an exported signature (`endpoint-signature.ts`) names this
 *  endpoint id. */
function signatureNamesEndpoint(signature: string, endpointId: string): boolean {
  return signature.split(';').some((entry) => entry.startsWith(`${endpointId}|`))
}

/** How long after a push the initial connectivity reports go out — the
 *  AddOrUpdateReport is accepted asynchronously, and a ChangeReport for an
 *  endpoint the cloud has not created yet is dropped. */
const INITIAL_CONNECTIVITY_DELAY_MS = 5_000

/**
 * The device whose online state an endpoint's connectivity reports: the
 * exposed device the endpoint is published under (a camera's own id, a
 * detection sensor's camera, a generic device's id).
 */
function connectivityDeviceOf(endpointId: string): number | null {
  const target = endpointAccessTarget(parseCameraEndpointId(endpointId))
  return target === null ? null : target.exposedDeviceId
}

/** The interface an endpoint must advertise for a `DoorbellPress` to survive
 *  the Alexa cloud. */
const DOORBELL_INTERFACE = 'Alexa.DoorbellEventSource'

/**
 * The interface an endpoint must advertise for an `ObjectDetection` event to
 * survive the Alexa cloud. Declared on a camera only while object detection is
 * on for it (R4, D779).
 *
 * Measured 2026-08-07, before the declaration existed: 223 `smartvision person
 * posted status=202` in 692 s on endpoint 104 alone, every one of them against
 * an endpoint whose discovered capability list did not contain this string. The
 * Event Gateway answers 202 because the ENVELOPE parsed; the cloud then drops
 * the event. D76: an accepted POST is not evidence of delivery.
 */
const SMART_VISION_INTERFACE = 'Alexa.SmartVision.ObjectDetectionSensor'

/**
 * How often the "SmartVision is not declared" drop is allowed to speak. A
 * branch that drops work must log it (`CLAUDE.md`), but at 223 drops per 11
 * minutes a per-event line is a line nobody reads — the same lesson the egress
 * teardown warn taught on 2026-08-07. First occurrence per endpoint, then every
 * hundredth, carrying the running count so the volume is never hidden.
 */
const SMART_VISION_DROP_LOG_EVERY = 100

interface ThrottleKey {
  readonly userId: string
  readonly endpointId: string
}

export class LwaEventGateway {
  private unsubscribe: (() => void) | null = null
  private unsubscribeMotion: (() => void) | null = null
  private unsubscribeConnectivity: Array<() => void> = []
  /** Last connectivity reported per `userId|endpointId` — a camera that
   *  re-announces the same state must not become a ChangeReport stream. */
  private readonly lastConnectivity = new Map<string, 'OK' | 'UNREACHABLE'>()
  /** Initial-connectivity reports waiting for the cloud to create endpoints. */
  private readonly pendingInitialReports = new Set<NodeJS.Timeout>()
  private refreshTimer: NodeJS.Timeout | null = null
  /** Caps concurrent state-change pushes to the gateway (D869). */
  private readonly pushLimiter = new ConcurrencyLimiter(GATEWAY_PUSH_CONCURRENCY)
  private readonly lastSentAt = new Map<string, number>()
  /**
   * What Alexa believes about each `userId|endpointId`'s `detectionState`,
   * and the falling-edge hold that keeps a flapping source from becoming a
   * flapping ChangeReport stream. This is the SINGLE authority on the motion
   * state we have reported — see `motion-clear-hold.ts` for the measurement
   * that made a plain transition dedupe insufficient.
   */
  private readonly motionHold = new MotionClearHold({
    holdMs: DEFAULT_MOTION_CLEAR_HOLD_MS,
  })
  /** Per-endpoint count of `ObjectDetection` events dropped because the
   *  endpoint does not declare {@link SMART_VISION_INTERFACE}. */
  private readonly smartVisionDropped = new Map<string, number>()
  /** Endpoints whose redacted ObjectDetection body was logged (D779 amendment). */
  private readonly smartVisionSampled = new Set<string>()
  /** Latches the "no grant at all" warning so it's logged ONCE, not on every
   *  doorbell/motion event while no account has a push grant. */
  private warnedNoGrant = false
  /** Users whose legacy grant is waiting for the broker URL (warned once). */
  private readonly warnedLegacyWaiting = new Set<string>()
  /** Per-user earliest next migration attempt after a failure. */
  private readonly migrationRetryAt = new Map<string, number>()
  /** Users we have already reported as having no stored Amazon push grant.
   *  Cleared for a user the moment a grant is found again, so a re-link
   *  re-arms the warning instead of muting it for the process's lifetime. */
  private readonly warnedNoToken = new Set<string>()

  constructor(private readonly deps: LwaEventGatewayDeps) {}

  start(): void {
    this.unsubscribe = this.deps.ctx.eventBus.subscribe(
      { category: EventCategory.DoorbellOnPressed },
      (event) => {
        this.onDoorbellPress(event.data as { deviceId: number; timestamp: number }).catch(
          (err: unknown) => {
            this.deps.logger.warn('alexa lwa-gateway: doorbell handler crashed', {
              meta: { error: err instanceof Error ? err.message : String(err) },
            })
          },
        )
      },
    )
    this.unsubscribeMotion = this.deps.ctx.eventBus.subscribe(
      { category: EventCategory.MotionOnMotionChanged },
      (event) => {
        this.onMotionChanged(
          event.data as { deviceId: number; detected: boolean; timestamp: number },
        ).catch((err: unknown) => {
          this.deps.logger.warn('alexa lwa-gateway: motion handler crashed', {
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        })
      },
    )
    this.unsubscribeConnectivity = [
      [EventCategory.DeviceOnline, 'OK'] as const,
      [EventCategory.DeviceOffline, 'UNREACHABLE'] as const,
    ].map(([category, connectivity]) =>
      this.deps.ctx.eventBus.subscribe({ category }, (event) => {
        this.onConnectivityChanged(event.data as { deviceId: number }, connectivity).catch(
          (err: unknown) => {
            this.deps.logger.warn('alexa lwa-gateway: connectivity handler crashed', {
              meta: { error: err instanceof Error ? err.message : String(err) },
            })
          },
        )
      }),
    )
    this.refreshTimer = setInterval(() => {
      this.refreshExpiringTokens().catch((err: unknown) => {
        this.deps.logger.warn('alexa lwa-gateway: token refresh scan crashed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
    }, REFRESH_SCAN_INTERVAL_MS)
    this.deps.logger.info('alexa lwa-gateway: started')
  }

  stop(): void {
    if (this.unsubscribe) this.unsubscribe()
    this.unsubscribe = null
    if (this.unsubscribeMotion) this.unsubscribeMotion()
    this.unsubscribeMotion = null
    for (const off of this.unsubscribeConnectivity) off()
    this.unsubscribeConnectivity = []
    this.lastConnectivity.clear()
    for (const timer of this.pendingInitialReports) clearTimeout(timer)
    this.pendingInitialReports.clear()
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    this.refreshTimer = null
    this.lastSentAt.clear()
    this.motionHold.clear()
    this.smartVisionDropped.clear()
    this.smartVisionSampled.clear()
    this.warnedNoToken.clear()
    this.warnedLegacyWaiting.clear()
    this.migrationRetryAt.clear()
  }

  // ── Doorbell push ───────────────────────────────────────────────

  private async onDoorbellPress(data: { deviceId: number; timestamp: number }): Promise<void> {
    // The cap fires on the child button device. We need the parent
    // camera id (Discovery exposes the camera, not the doorbell button).
    const childDevice = await this.deps.ctx.api.deviceManager.getDevice
      .query({ deviceId: data.deviceId })
      .catch(() => null)
    if (!childDevice) {
      this.deps.logger.warn(
        'alexa lwa-gateway: doorbell press DROPPED — the pressing device is not in the registry',
        { tags: { deviceId: data.deviceId } },
      )
      return
    }
    const parentDeviceId = childDevice.parentDeviceId ?? data.deviceId
    const exposed = this.deps.listExposed().some((e) => e.deviceId === parentDeviceId)
    if (!exposed) {
      this.deps.logger.info(
        'alexa lwa-gateway: doorbell press ignored — the camera is not exposed to Alexa',
        { tags: { deviceId: parentDeviceId } },
      )
      return
    }

    const endpointId = String(parentDeviceId)
    // Pre-flight the cloud-side shape. A 2xx from the Event Gateway means the
    // envelope parsed, NOT that the endpoint could act on it: Alexa discards a
    // DoorbellPress aimed at an endpoint that never declared
    // `Alexa.DoorbellEventSource`, which is precisely how camera 101 logged
    // "doorbell press posted" while every Echo stayed silent (2026-08-07).
    const signature = this.deps.getExportedSignature(parentDeviceId)
    if (signature !== null && !signature.includes(DOORBELL_INTERFACE)) {
      this.deps.logger.warn(
        `alexa lwa-gateway: the endpoint Alexa knows does NOT declare ${DOORBELL_INTERFACE} — this press will be accepted by the gateway and DROPPED by the cloud; the discovery reconcile must re-push this endpoint`,
        { tags: { deviceId: parentDeviceId }, meta: { endpointId, signature } },
      )
    }
    const linked = this.deps.listLinkedAccounts()
    if (linked.length === 0) {
      this.deps.logger.info('alexa lwa-gateway: doorbell press but no linked accounts — skipped', {
        meta: { parentDeviceId },
      })
      return
    }
    if (!this.hasProactiveCredentials()) return

    for (const account of linked) {
      if (!this.mayPush(account.userId, parentDeviceId, 'doorbell press')) continue
      const tokens = this.findToken(account.userId)
      if (!tokens) {
        this.deps.logger.info('alexa lwa-gateway: no LWA token for user — skipped', {
          tags: { deviceId: parentDeviceId },
          meta: { userId: account.userId },
        })
        continue
      }
      if (this.isThrottled({ userId: account.userId, endpointId })) {
        this.deps.logger.info('alexa lwa-gateway: throttled doorbell press', {
          meta: { userId: account.userId, endpointId },
        })
        continue
      }
      await this.postDoorbellPress({
        userId: account.userId,
        endpointId,
        timestamp: data.timestamp,
      })
    }
  }

  /**
   * S1: the account's hub user may view `deviceId`. A refusal is logged at
   * debug — for a scoped user it is the EXPECTED outcome for every camera
   * outside the grant, many times a minute.
   */
  private mayPush(userId: string, deviceId: number, label: string): boolean {
    if (this.deps.accountMaySee(userId, deviceId)) return true
    this.deps.logger.debug(
      `alexa lwa-gateway: ${label} not sent to this account — its hub user may not view the device`,
      { tags: { deviceId }, meta: { userId } },
    )
    return false
  }

  private isThrottled(key: ThrottleKey): boolean {
    const composite = `${key.userId}|${key.endpointId}`
    const last = this.lastSentAt.get(composite) ?? 0
    if (Date.now() - last < THROTTLE_WINDOW_MS) return true
    this.lastSentAt.set(composite, Date.now())
    return false
  }

  private async postDoorbellPress(opts: {
    userId: string
    endpointId: string
    timestamp: number
  }): Promise<void> {
    await this.postEventBody(
      opts.userId,
      opts.endpointId,
      (accessToken) => buildDoorbellPressPayload({ ...opts, accessToken }),
      'doorbell press',
    )
  }

  // ── Motion push ─────────────────────────────────────────────────

  /**
   * Camera-native motion flipped. Report it as an `Alexa.MotionSensor`
   * ChangeReport: the rising edge immediately, the falling edge only once the
   * source has stayed quiet (see `MotionClearHold` for the 104 measurement
   * that made a plain transition dedupe insufficient).
   */
  private async onMotionChanged(data: {
    deviceId: number
    detected: boolean
    timestamp: number
  }): Promise<void> {
    const exposed = this.deps.listExposed().some((e) => e.deviceId === data.deviceId)
    if (!exposed) return
    const endpointId = String(data.deviceId)
    await this.pushMotionState({
      deviceId: data.deviceId,
      endpointId,
      detected: data.detected,
      timestamp: data.timestamp,
      label: 'motion',
    })
  }

  /**
   * A camera's detection class appeared or cleared (R1, D772): report it on
   * that class's detection-sensor endpoint, with the same hold as camera
   * motion (instant rising edge; NOT_DETECTED only after the source went
   * quiet and at least 30 s after DETECTED, Amazon's MotionSensor rule).
   *
   * Posted only to an endpoint Alexa KNOWS: a ChangeReport for an endpoint the
   * last AddOrUpdateReport did not contain is a 202 the cloud discards (D76),
   * so the exported signature must name it.
   */
  async pushDetectionSensor(opts: {
    deviceId: number
    endpointId: string
    detected: boolean
    timestamp: number
  }): Promise<void> {
    if (!this.deps.listExposed().some((e) => e.deviceId === opts.deviceId)) return
    const signature = this.deps.getExportedSignature(opts.deviceId)
    if (signature === null || !signatureNamesEndpoint(signature, opts.endpointId)) {
      this.deps.logger.debug(
        'alexa lwa-gateway: detection change not sent — Alexa has not been told about this sensor endpoint',
        { tags: { deviceId: opts.deviceId }, meta: { endpointId: opts.endpointId } },
      )
      return
    }
    await this.pushMotionState({ ...opts, label: 'detection' })
  }

  /** The per-account MotionSensor ChangeReport loop shared by camera motion
   *  and the detection sensors. The hold is keyed per account AND endpoint. */
  private async pushMotionState(opts: {
    deviceId: number
    endpointId: string
    detected: boolean
    timestamp: number
    label: string
  }): Promise<void> {
    const { deviceId, endpointId } = opts
    const linked = this.deps.listLinkedAccounts()
    if (linked.length === 0) return
    if (!this.hasProactiveCredentials()) return

    for (const account of linked) {
      if (!this.mayPush(account.userId, deviceId, opts.label)) continue
      const tokens = this.findToken(account.userId)
      if (!tokens) continue
      const key = `${account.userId}|${endpointId}`

      if (!opts.detected) {
        // Arm the hold. The release runs on a timer, so it must carry its own
        // failure handling — nothing above it is awaiting this.
        this.motionHold.onCleared(key, () => {
          this.postMotionChange({
            userId: account.userId,
            endpointId,
            detected: false,
            timestamp: Date.now(),
          }).catch((err: unknown) => {
            this.deps.logger.warn(`alexa lwa-gateway: held ${opts.label} clear failed to post`, {
              tags: { deviceId },
              meta: { endpointId, error: err instanceof Error ? err.message : String(err) },
            })
          })
        })
        continue
      }

      if (!this.motionHold.onDetected(key)) continue
      await this.postMotionChange({
        userId: account.userId,
        endpointId,
        detected: true,
        timestamp: opts.timestamp,
      })
    }
  }

  private async postMotionChange(opts: {
    userId: string
    endpointId: string
    detected: boolean
    timestamp: number
  }): Promise<void> {
    await this.postEventBody(
      opts.userId,
      opts.endpointId,
      (accessToken) => buildMotionChangeReportPayload({ ...opts, accessToken }),
      `motion ${opts.detected ? 'DETECTED' : 'NOT_DETECTED'}`,
    )
  }

  /**
   * Post one `Alexa.SmartVision.ObjectDetectionSensor/ObjectDetection` event
   * (R4, D779) to every linked account whose hub user may view the camera.
   *
   * Fed by `ObjectDetectionFeed` from the pipeline's tracks — never by camera
   * motion. Gated on the endpoint Alexa holds DECLARING the interface (the
   * exported signature's entry for the camera endpoint): an event for an
   * endpoint without it is a 2xx the cloud discards (D76), and before D779
   * that was ~1 POST/s per flapping camera. The drop is logged sparsely.
   *
   * Images are minted PER ACCOUNT (`imagesFor`): an image URL is checked
   * against the account-link token of the user it was minted for.
   */
  async postObjectDetection(opts: {
    readonly deviceId: number
    readonly detection: VisionDetectionLike
    readonly imagesFor?: (userId: string) => {
      readonly frameImageUri?: string
      readonly croppedImageUri?: string
    }
  }): Promise<void> {
    const endpointId = String(opts.deviceId)
    const signature = this.deps.getExportedSignature(opts.deviceId)
    const declared =
      signature !== null &&
      signatureEntries(signature).some(
        (e) => e.endpointId === endpointId && e.interfaces.includes(SMART_VISION_INTERFACE),
      )
    if (!declared) {
      const dropped = (this.smartVisionDropped.get(endpointId) ?? 0) + 1
      this.smartVisionDropped.set(endpointId, dropped)
      if (dropped === 1 || dropped % SMART_VISION_DROP_LOG_EVERY === 0) {
        this.deps.logger.info(
          `alexa lwa-gateway: ObjectDetection NOT posted — the endpoint Alexa knows does not declare ${SMART_VISION_INTERFACE}, so the cloud would accept and discard it`,
          {
            tags: { deviceId: opts.deviceId },
            meta: { endpointId, droppedSoFar: dropped, signature },
          },
        )
      }
      return
    }
    const linked = this.deps.listLinkedAccounts()
    if (linked.length === 0 || !this.hasProactiveCredentials()) return
    const d = opts.detection
    for (const account of linked) {
      if (!this.mayPush(account.userId, opts.deviceId, 'object detection')) continue
      const images = opts.imagesFor?.(account.userId) ?? {}
      if (!this.smartVisionSampled.has(endpointId)) {
        this.smartVisionSampled.add(endpointId)
        this.deps.logger.info('alexa lwa-gateway: ObjectDetection body sample (redacted)', {
          tags: { deviceId: opts.deviceId },
          meta: {
            body: redactedObjectDetectionSample({
              userId: account.userId,
              endpointId,
              detections: [
                {
                  eventIdentifier: d.eventIdentifier,
                  imageNetClass: d.imageNetClass,
                  objectIdentifier: d.objectIdentifier,
                  ...images,
                },
              ],
              timestamp: d.timestamp,
              accessToken: '',
            }),
          },
        })
      }
      await this.postEventBody(
        account.userId,
        endpointId,
        (accessToken) =>
          buildSmartVisionObjectDetectionEvent({
            userId: account.userId,
            endpointId,
            detections: [
              {
                eventIdentifier: d.eventIdentifier,
                imageNetClass: d.imageNetClass,
                objectIdentifier: d.objectIdentifier,
                ...images,
              },
            ],
            timestamp: d.timestamp,
            accessToken,
          }),
        `smartvision ${d.imageNetClass} (track ${d.trackId}, images ${images.frameImageUri === undefined ? 'off' : 'on'})`,
      )
    }
  }

  // ── Connectivity push (Alexa.EndpointHealth) ────────────────────

  /**
   * A camera went offline or came back. Amazon requires the `connectivity`
   * ChangeReport within 3 s of the change (alexa-endpointhealth). Deduped per
   * account and endpoint, and skipped for an endpoint Alexa is known to hold
   * WITHOUT `Alexa.EndpointHealth` — the cloud would drop it (D76).
   */
  private async onConnectivityChanged(
    data: { deviceId: number },
    connectivity: 'OK' | 'UNREACHABLE',
  ): Promise<void> {
    if (typeof data?.deviceId !== 'number') return
    await this.reportConnectivity(data.deviceId, connectivity)
  }

  /**
   * A device went offline or came back: report `connectivity` on EVERY
   * endpoint of it that Alexa knows with `Alexa.EndpointHealth` — the camera
   * and its detection sensors (D770). Fed by the generic `device-status`
   * slice (R3) and by the providers that also emit DeviceOnline/Offline;
   * deduplicated per account and endpoint, so the two sources never double-post.
   */
  async reportConnectivity(deviceId: number, connectivity: 'OK' | 'UNREACHABLE'): Promise<void> {
    if (!this.deps.listExposed().some((e) => e.deviceId === deviceId)) return
    const signature = this.deps.getExportedSignature(deviceId)
    const endpointIds =
      signature === null
        ? [String(deviceId)]
        : signatureEntries(signature)
            .filter((e) => e.interfaces.includes(ENDPOINT_HEALTH_INTERFACE))
            .map((e) => e.endpointId)
    if (endpointIds.length === 0) return
    const linked = this.deps.listLinkedAccounts()
    if (linked.length === 0) return
    if (!this.hasProactiveCredentials()) return

    for (const account of linked) {
      if (!this.mayPush(account.userId, deviceId, 'connectivity')) continue
      for (const endpointId of endpointIds) {
        const key = `${account.userId}|${endpointId}`
        if (this.lastConnectivity.get(key) === connectivity) continue
        this.lastConnectivity.set(key, connectivity)
        await this.postEventBody(
          account.userId,
          endpointId,
          (accessToken) =>
            buildConnectivityChangeReportPayload({
              endpointId,
              connectivity,
              timestamp: Date.now(),
              accessToken,
            }),
          `connectivity ${connectivity}`,
        )
      }
    }
  }

  /**
   * A device state change Alexa should hear about (R3, D776): the alarm
   * panel, a privacy/autotrack switch, an accessory. Posted only to an
   * endpoint Alexa knows WITH the interface the properties belong to (D76).
   */
  async postStateChange(report: StateReport): Promise<void> {
    if (!this.deps.listExposed().some((e) => e.deviceId === report.exposedDeviceId)) return
    const signature = this.deps.getExportedSignature(report.exposedDeviceId)
    const entry =
      signature === null
        ? undefined
        : signatureEntries(signature).find((e) => e.endpointId === report.endpointId)
    if (entry === undefined || !entry.interfaces.includes(report.interfaceName)) {
      this.deps.logger.debug(
        'alexa lwa-gateway: state change not sent — Alexa has not been told about this endpoint/interface',
        {
          tags: { deviceId: report.exposedDeviceId },
          meta: { endpointId: report.endpointId, interfaceName: report.interfaceName },
        },
      )
      return
    }
    const linked = this.deps.listLinkedAccounts()
    if (linked.length === 0) return
    if (!this.hasProactiveCredentials()) return
    for (const account of linked) {
      if (!this.mayPush(account.userId, report.exposedDeviceId, 'state change')) continue
      if (!this.findToken(account.userId)) continue
      await this.pushLimiter.run(() =>
        this.postEventBody(
          account.userId,
          report.endpointId,
          (accessToken) =>
            buildStateChangeReportPayload({
              endpointId: report.endpointId,
              properties: report.properties,
              timestamp: Date.now(),
              accessToken,
            }),
          `state ${report.interfaceName}`,
        ),
      )
    }
  }

  /**
   * The asynchronous result of a deferred directive (D869): the `Response` (or
   * `ErrorResponse`) Alexa waits for after a `DeferredResponse`, sent through
   * the Event Gateway to the account that issued the directive.
   */
  async sendAsyncResponse(input: AsyncResponseInput): Promise<boolean> {
    return this.pushLimiter.run(() =>
      this.postEventBody(
        input.userId,
        input.endpointId,
        (accessToken) =>
          buildAsyncResponsePayload({
            endpointId: input.endpointId,
            correlationToken: input.correlationToken,
            outcome: input.outcome,
            accessToken,
          }),
        `async ${input.outcome.kind}`,
      ),
    )
  }

  // ── Initial connectivity (Alexa.EndpointHealth) ─────────────────

  /**
   * After endpoints reach an account (AddOrUpdateReport or a Discover answer),
   * tell Alexa each one's connectivity, so it never holds an endpoint of
   * unknown health — the state in which the phone app refused live view
   * (D770). Delayed so the cloud has created the endpoints the report names.
   * Only endpoints that DECLARE `Alexa.EndpointHealth` are reported.
   */
  scheduleInitialConnectivity(userId: string, endpoints: readonly AlexaEndpoint[]): void {
    const targets = endpoints.filter((e) =>
      e.capabilities.some((c) => c.interface === ENDPOINT_HEALTH_INTERFACE),
    )
    if (targets.length === 0) return
    const timer = setTimeout(() => {
      void this.reportInitialConnectivity(userId, targets).catch((err: unknown) => {
        this.deps.logger.warn('alexa lwa-gateway: initial connectivity report failed', {
          meta: { userId, error: err instanceof Error ? err.message : String(err) },
        })
      })
    }, INITIAL_CONNECTIVITY_DELAY_MS)
    timer.unref?.()
    this.pendingInitialReports.add(timer)
  }

  private async reportInitialConnectivity(
    userId: string,
    endpoints: readonly AlexaEndpoint[],
  ): Promise<void> {
    if (!this.hasProactiveCredentials()) return
    for (const endpoint of endpoints) {
      const deviceId = connectivityDeviceOf(endpoint.endpointId)
      if (deviceId === null) continue
      if (!this.mayPush(userId, deviceId, 'initial connectivity')) continue
      const connectivity = await readConnectivity(this.deps.ctx.api, deviceId, this.deps.logger)
      this.lastConnectivity.set(`${userId}|${endpoint.endpointId}`, connectivity)
      await this.postEventBody(
        userId,
        endpoint.endpointId,
        (accessToken) =>
          buildConnectivityChangeReportPayload({
            endpointId: endpoint.endpointId,
            connectivity,
            timestamp: Date.now(),
            accessToken,
          }),
        `initial connectivity ${connectivity}`,
      )
    }
  }

  // ── Manual stale-endpoint purge (DeleteReport) ──────────────────

  /**
   * Send a one-shot `DeleteReport` for arbitrary endpoint ids per linked
   * account. Used to clean up stale entries Alexa still shows from prior
   * syncs (different addon version, different account, or an aborted
   * unexpose) that aren't tracked in our local `exportedEndpoints` map.
   *
   * Returns the per-account outcome: how many DeleteReport batches succeeded
   * (one batch per account) plus the per-account failures. The same set of
   * endpoint ids is sent to every linked account so any extant ghosts on
   * either side get cleared.
   */
  async purgeEndpoints(endpointIds: readonly string[]): Promise<PurgeEndpointsResult> {
    const linked = this.deps.listLinkedAccounts()
    let deliveredAccounts = 0
    if (endpointIds.length > 0) {
      for (const account of linked) {
        // `postEventBody` answers false for a missing grant as well as for a
        // refusal — either way the delete did not reach this account.
        const ok = await this.postEventBody(
          account.userId,
          'discovery',
          (accessToken) => buildDeleteReportPayload(account.userId, endpointIds, accessToken),
          `discovery delete (manual, ${endpointIds.length})`,
        )
        if (ok) deliveredAccounts += 1
      }
    }
    return {
      requested: endpointIds.length,
      accountCount: linked.length,
      deliveredAccounts,
      failedAccounts: endpointIds.length > 0 ? linked.length - deliveredAccounts : 0,
    }
  }

  // ── Event Gateway POST (shared by doorbell + motion) ────────────

  /** Public delivery used by the SyncEngine. Returns true on gateway 2xx.
   *  `buildBody` is handed the access token the request will actually be sent
   *  with, so the body's `scope.token` and the `Authorization` header can never
   *  disagree — including after a 401 refresh. */
  async postReport(
    userId: string,
    buildBody: (accessToken: string) => unknown,
    label: string,
  ): Promise<boolean> {
    return this.postEventBody(userId, 'discovery', buildBody, label)
  }

  /** POST a proactive-event body to the region's Event Gateway, refreshing
   *  the LWA token once on 401.
   *
   *  The body is BUILT PER ATTEMPT from the token that attempt uses: the
   *  Smart Home payloads carry the bearer token inside `scope.token` as well
   *  as in the header, and a body built with the expired token then retried
   *  with a fresh header would ship a token Amazon has already rejected. */
  private async postEventBody(
    userId: string,
    endpointId: string,
    buildBody: (accessToken: string) => unknown,
    label: string,
  ): Promise<boolean> {
    const url = EVENT_GATEWAY_URLS[this.deps.getRegion()]
    // One body per token: a retry re-sends the SAME message (same messageId),
    // so a 503 that the gateway in fact processed cannot become two events.
    const send = async (accessToken: string): Promise<Response> => {
      const body = JSON.stringify(buildBody(accessToken))
      return sendWithGatewayRetry(
        () =>
          fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${accessToken}`,
            },
            body,
          }),
        (attempt, reason, delayMs) => {
          this.deps.logger.info(`alexa lwa-gateway: ${label} retrying`, {
            meta: { userId, endpointId, attempt, reason, delayMs },
          })
        },
      )
    }

    const initial = this.findToken(userId)
    if (!initial) {
      // Every proactive push funnels through here, so this is the ONE place a
      // missing Amazon grant drops work — and until now it dropped it in
      // silence, which reads as "the event never happened". Latched per user:
      // motion alone would emit this several times a minute.
      if (!this.warnedNoToken.has(userId)) {
        this.warnedNoToken.add(userId)
        this.deps.logger.warn(
          `alexa lwa-gateway: ${label} DROPPED — no Amazon push grant stored for this account, so no proactive event can be delivered; re-link the skill in the Alexa app`,
          { meta: { userId, endpointId } },
        )
      }
      return false
    }
    this.warnedNoToken.delete(userId)
    let response = await send(initial.accessToken).catch((err: unknown) => {
      this.deps.logger.warn('alexa lwa-gateway: fetch crashed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return null
    })
    if (!response) return false

    if (response.status === 401) {
      const refreshed = await this.refreshAccessToken(userId).catch((err: unknown) => {
        this.deps.logger.warn('alexa lwa-gateway: refresh failed', {
          meta: { userId, error: err instanceof Error ? err.message : String(err) },
        })
        return null
      })
      if (refreshed) {
        response = await send(refreshed).catch(() => null)
      }
    }
    if (!response) return false
    if (response.status === 403) {
      this.deps.logger.warn('alexa lwa-gateway: 403 from gateway — token likely revoked', {
        meta: { userId, endpointId },
      })
      await this.deps.removeLinkedAccount(userId).catch(() => {})
      return false
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      this.deps.logger.warn(`alexa lwa-gateway: ${label} push failed`, {
        meta: { userId, endpointId, status: response.status, body: text.slice(0, 500) },
      })
      return false
    }
    // `posted` used to mean only "fetch resolved without throwing", which is
    // exactly how a real doorbell press produced a success line and no Echo
    // announcement (2026-08-07). Carry the HTTP status so the line states what
    // Amazon actually answered — and say out loud that a 2xx from the Event
    // Gateway is an ACCEPTANCE of the envelope, not proof the endpoint could
    // act on it: an endpoint whose discovered capabilities lack the event's
    // interface is answered 202 and then silently dropped by the cloud.
    this.deps.logger.info(`alexa lwa-gateway: ${label} posted`, {
      meta: { userId, endpointId, status: response.status },
    })
    return true
  }

  // ── Token renewal (through the skill's broker) ──────────────────

  private get fetchImpl(): FetchLike {
    return this.deps.fetchImpl ?? ((url, init) => fetch(url, init))
  }

  private async refreshExpiringTokens(): Promise<void> {
    if (!this.hasProactiveCredentials()) return
    const tokens = this.deps.listTokens()
    const now = Date.now()
    for (const token of tokens) {
      // A legacy grant is migrated as soon as possible, not at expiry: until it
      // is, this hub holds a refresh token it cannot use and should not keep.
      const due = !isBrokerGrant(token) || token.expiresAt - now <= REFRESH_PROACTIVE_WINDOW_MS
      if (!due) continue
      await this.refreshAccessToken(token.userId).catch((err: unknown) => {
        this.deps.logger.warn('alexa lwa-gateway: proactive refresh failed', {
          meta: { userId: token.userId, error: err instanceof Error ? err.message : String(err) },
        })
      })
    }
  }

  /** A fresh access token for `userId`, or null. Never throws for broker errors. */
  private async refreshAccessToken(userId: string): Promise<string | null> {
    const existing = this.findToken(userId)
    if (!existing) return null
    if (!isBrokerGrant(existing)) return this.migrateLegacyGrant(existing)
    try {
      const fresh = await fetchBrokerAccessToken(
        this.fetchImpl,
        existing.brokerUrl,
        existing.brokerCredential,
      )
      await this.deps.upsertToken({
        userId,
        accessToken: fresh.accessToken,
        expiresAt: fresh.expiresAt,
        brokerUrl: existing.brokerUrl,
        brokerCredential: existing.brokerCredential,
      })
      return fresh.accessToken
    } catch (err) {
      if (err instanceof BrokerError && (err.kind === 'unauthorized' || err.kind === 'revoked')) {
        this.deps.logger.warn(
          'alexa lwa-gateway: the skill broker no longer recognises this link — proactive events stop; re-link the skill in the Alexa app',
          { meta: { userId, kind: err.kind } },
        )
        await this.deps.removeLinkedAccount(userId).catch(() => {})
        return null
      }
      this.deps.logger.warn('alexa lwa-gateway: broker renewal failed — will retry', {
        meta: { userId, error: err instanceof Error ? err.message : String(err) },
      })
      return null
    }
  }

  /**
   * Hand a pre-D753 refresh token to the skill's broker and keep the link it
   * returns instead. Zero-touch: the broker URL arrives on the next verified
   * directive. On success the refresh token is gone from this hub.
   */
  private async migrateLegacyGrant(entry: LwaTokenEntry): Promise<string | null> {
    const userId = entry.userId
    if (!entry.refreshToken) return null
    const brokerUrl = this.deps.getAdvertisedBrokerUrl()
    if (!brokerUrl) {
      if (!this.warnedLegacyWaiting.has(userId)) {
        this.warnedLegacyWaiting.add(userId)
        this.deps.logger.warn(
          'alexa lwa-gateway: this Amazon push grant predates the skill broker and this hub holds no LWA secret to renew it; it migrates automatically once the skill Lambda advertises its broker (next Alexa directive). Until then events stop when the current token expires.',
          { meta: { userId, expiresInMs: entry.expiresAt - Date.now() } },
        )
      }
      return null
    }
    const retryAt = this.migrationRetryAt.get(userId) ?? 0
    if (Date.now() < retryAt) return null
    try {
      const migrated = await migrateLegacyGrant(this.fetchImpl, brokerUrl, {
        refreshToken: entry.refreshToken,
        ...(this.deps.getPublicHubUrl ? { hubUrl: this.deps.getPublicHubUrl() } : {}),
      })
      await this.deps.upsertToken({
        userId,
        accessToken: migrated.accessToken,
        expiresAt: migrated.expiresAt,
        brokerUrl: normaliseBrokerUrl(migrated.brokerUrl) ?? brokerUrl,
        brokerCredential: migrated.brokerCredential,
      })
      this.migrationRetryAt.delete(userId)
      this.warnedLegacyWaiting.delete(userId)
      this.deps.logger.info(
        'alexa lwa-gateway: migrated the Amazon push grant to the skill broker; the refresh token was deleted from this hub',
        { meta: { userId } },
      )
      return migrated.accessToken
    } catch (err) {
      this.migrationRetryAt.set(userId, Date.now() + MIGRATION_RETRY_MS)
      const kind = err instanceof BrokerError ? err.kind : 'unavailable'
      const status = err instanceof BrokerError ? err.status : undefined
      if (kind === 'rejected' && status === 400) {
        // The broker refreshed it with the skill's secret and Amazon said no:
        // the grant is dead. Same as a gateway 403.
        this.deps.logger.warn(
          'alexa lwa-gateway: Amazon no longer honours this push grant — re-link the skill in the Alexa app',
          { meta: { userId } },
        )
        await this.deps.removeLinkedAccount(userId).catch(() => {})
        return null
      }
      this.deps.logger.warn('alexa lwa-gateway: migrating the push grant to the broker failed', {
        meta: { userId, error: err instanceof Error ? err.message : String(err) },
      })
      return null
    }
  }

  private findToken(userId: string): LwaTokenEntry | null {
    return this.deps.listTokens().find((t) => t.userId === userId) ?? null
  }

  /**
   * Proactive push needs a stored grant for at least one account. With none,
   * pushing is futile — skip it and warn ONCE instead of once per event.
   * (Per-account absence is reported in `postEventBody`.)
   */
  private hasProactiveCredentials(): boolean {
    if (this.deps.listTokens().length > 0) {
      this.warnedNoGrant = false
      return true
    }
    if (!this.warnedNoGrant) {
      this.warnedNoGrant = true
      this.deps.logger.warn(
        'alexa lwa-gateway: proactive events (doorbell/motion/discovery) skipped — no Amazon push grant is stored; link the skill in the Alexa app',
      )
    }
    return false
  }
}

// ── Event Gateway retry (pure) ──────────────────────────────────────

/**
 * Statuses Amazon tells a sender to retry (smarthome/send-events: 429
 * THROTTLING, 500 INTERNAL_SERVICE, 503 SERVICE_UNAVAILABLE — "resend the
 * message up to three times, with at least a one-second interval").
 */
const RETRYABLE_GATEWAY_STATUSES: ReadonlySet<number> = new Set([429, 500, 503])

/** Delays before retry 1, 2, 3 — bounded, at least one second each. */
export const GATEWAY_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000]

/** A `Retry-After` the gateway sends is honoured up to this much. */
const MAX_RETRY_AFTER_MS = 10_000

function retryAfterMs(response: Response): number {
  const raw = response.headers?.get?.('retry-after')
  if (raw === null || raw === undefined) return 0
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : 0
}

/**
 * POST with Amazon's retry rule: a retryable status or a network failure is
 * re-sent up to three times, waiting 1 s / 2 s / 4 s (or the gateway's
 * `Retry-After`, capped). Anything else — 2xx, 401 (renewal is the caller's),
 * 403, 400 — is returned at once. The last answer (or the last network error)
 * is what the caller sees.
 */
export async function sendWithGatewayRetry(
  attemptOnce: () => Promise<Response>,
  onRetry: (attempt: number, reason: string, delayMs: number) => void,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let response: Response | null = null
    let failure: unknown = null
    try {
      response = await attemptOnce()
    } catch (err) {
      failure = err
    }
    const retryable = response === null || RETRYABLE_GATEWAY_STATUSES.has(response.status)
    const delay = GATEWAY_RETRY_DELAYS_MS[attempt]
    if (!retryable || delay === undefined) {
      if (response !== null) return response
      throw failure
    }
    const wait = response === null ? delay : Math.max(delay, retryAfterMs(response))
    onRetry(
      attempt + 1,
      response === null
        ? `network: ${failure instanceof Error ? failure.message : String(failure)}`
        : `status ${response.status}`,
      wait,
    )
    await new Promise<void>((resolve) => {
      setTimeout(resolve, wait).unref?.()
    })
  }
}

// ── Payload builder (pure) ──────────────────────────────────────────

interface DoorbellPressPayload {
  readonly event: {
    readonly header: {
      readonly namespace: 'Alexa.DoorbellEventSource'
      readonly name: 'DoorbellPress'
      readonly messageId: string
      readonly payloadVersion: '3'
    }
    readonly endpoint: {
      readonly scope: { readonly type: 'BearerToken'; readonly token: string }
      readonly endpointId: string
    }
    readonly payload: {
      readonly cause: { readonly type: 'PHYSICAL_INTERACTION' }
      readonly timestamp: string
    }
  }
}

export function buildDoorbellPressPayload(opts: {
  userId: string
  endpointId: string
  timestamp: number
  accessToken: string
}): DoorbellPressPayload {
  return {
    event: {
      header: {
        namespace: 'Alexa.DoorbellEventSource',
        name: 'DoorbellPress',
        messageId: randomUUID(),
        payloadVersion: '3',
      },
      endpoint: {
        // The Smart Home spec puts the user's LWA access token in BOTH the
        // Authorization header and `endpoint.scope.token`. This used to send a
        // placeholder on the assumption Amazon reads only the header — an
        // assumption nothing could verify, because the Event Gateway answers
        // 202 either way and the cloud drops the event in silence.
        scope: { type: 'BearerToken', token: opts.accessToken },
        endpointId: opts.endpointId,
      },
      payload: {
        cause: { type: 'PHYSICAL_INTERACTION' },
        timestamp: new Date(opts.timestamp).toISOString(),
      },
    },
  }
}

// ── Motion ChangeReport payload builder (pure) ──────────────────────

interface MotionChangeReport {
  readonly event: {
    readonly header: {
      readonly namespace: 'Alexa'
      readonly name: 'ChangeReport'
      readonly messageId: string
      readonly payloadVersion: '3'
    }
    readonly endpoint: {
      readonly scope: { readonly type: 'BearerToken'; readonly token: string }
      readonly endpointId: string
    }
    readonly payload: {
      readonly change: {
        readonly cause: { readonly type: 'PHYSICAL_INTERACTION' }
        readonly properties: ReadonlyArray<{
          readonly namespace: 'Alexa.MotionSensor'
          readonly name: 'detectionState'
          readonly value: 'DETECTED' | 'NOT_DETECTED'
          readonly timeOfSample: string
          readonly uncertaintyInMilliseconds: number
        }>
      }
    }
  }
  readonly context: { readonly properties: readonly [] }
}

export function buildMotionChangeReportPayload(opts: {
  userId: string
  endpointId: string
  detected: boolean
  timestamp: number
  accessToken: string
}): MotionChangeReport {
  const timeOfSample = new Date(opts.timestamp).toISOString()
  return {
    event: {
      header: {
        namespace: 'Alexa',
        name: 'ChangeReport',
        messageId: randomUUID(),
        payloadVersion: '3',
      },
      endpoint: {
        scope: { type: 'BearerToken', token: opts.accessToken },
        endpointId: opts.endpointId,
      },
      payload: {
        change: {
          cause: { type: 'PHYSICAL_INTERACTION' },
          properties: [
            {
              namespace: 'Alexa.MotionSensor',
              name: 'detectionState',
              value: opts.detected ? 'DETECTED' : 'NOT_DETECTED',
              timeOfSample,
              uncertaintyInMilliseconds: 0,
            },
          ],
        },
      },
    },
    context: { properties: [] },
  }
}

// ── Generic state ChangeReport payload builder (pure) ───────────────

export function buildStateChangeReportPayload(opts: {
  endpointId: string
  properties: readonly StateReport['properties'][number][]
  timestamp: number
  accessToken: string
}): unknown {
  const timeOfSample = new Date(opts.timestamp).toISOString()
  return {
    event: {
      header: {
        namespace: 'Alexa',
        name: 'ChangeReport',
        messageId: randomUUID(),
        payloadVersion: '3',
      },
      endpoint: {
        scope: { type: 'BearerToken', token: opts.accessToken },
        endpointId: opts.endpointId,
      },
      payload: {
        change: {
          cause: { type: 'PHYSICAL_INTERACTION' },
          properties: opts.properties.map((p) => ({
            namespace: p.namespace,
            name: p.name,
            ...(p.instance !== undefined ? { instance: p.instance } : {}),
            value: p.value,
            timeOfSample,
            uncertaintyInMilliseconds: 0,
          })),
        },
      },
    },
    context: { properties: [] },
  }
}

// ── EndpointHealth ChangeReport payload builder (pure) ──────────────

export function buildConnectivityChangeReportPayload(opts: {
  endpointId: string
  connectivity: 'OK' | 'UNREACHABLE'
  timestamp: number
  accessToken: string
}): unknown {
  return {
    event: {
      header: {
        namespace: 'Alexa',
        name: 'ChangeReport',
        messageId: randomUUID(),
        payloadVersion: '3',
      },
      endpoint: {
        scope: { type: 'BearerToken', token: opts.accessToken },
        endpointId: opts.endpointId,
      },
      payload: {
        change: {
          cause: { type: 'PERIODIC_POLL' },
          properties: [
            {
              namespace: 'Alexa.EndpointHealth',
              name: 'connectivity',
              value: { value: opts.connectivity },
              timeOfSample: new Date(opts.timestamp).toISOString(),
              uncertaintyInMilliseconds: 0,
            },
          ],
        },
      },
    },
    context: { properties: [] },
  }
}

// ── SmartVision ObjectDetection event (pure) ─────────────────────────
//
// `Alexa.SmartVision.ObjectDetectionSensor` defines a dedicated
// `ObjectDetection` event with `payloadVersion: '1.0'` — NOT a generic
// `Alexa/ChangeReport`. Per the spec the `imageNetClass` enum is
// restricted to `person` and `package`; we map every plain-motion
// trigger to `person` because the Alexa cloud rejects free-form
// strings and silently drops the event. `frameImageUri` is optional;
// when provided the Alexa app fetches the thumbnail via a `GET` with
// `Authorization: Bearer <token>` from the user-scope bearer token.

export type SmartVisionImageNetClass = 'person' | 'package'

/** What the object-detection feed hands the gateway for one event. */
export interface VisionDetectionLike {
  readonly trackId: string
  readonly imageNetClass: SmartVisionImageNetClass
  readonly eventIdentifier: string
  readonly objectIdentifier: string
  readonly timestamp: number
}

interface SmartVisionObjectDetectionEvent {
  readonly event: {
    readonly header: {
      readonly namespace: 'Alexa.SmartVision.ObjectDetectionSensor'
      readonly name: 'ObjectDetection'
      readonly messageId: string
      readonly payloadVersion: '1.0'
    }
    readonly endpoint: {
      readonly scope: { readonly type: 'BearerToken'; readonly token: string }
      readonly endpointId: string
    }
    readonly payload: {
      readonly events: ReadonlyArray<{
        readonly eventIdentifier: string
        readonly imageNetClass: SmartVisionImageNetClass
        readonly timeOfSample: string
        readonly uncertaintyInMilliseconds: number
        readonly objectIdentifier?: string
        readonly frameImageUri?: string
        readonly croppedImageUri?: string
      }>
    }
  }
}

export interface SmartVisionDetection {
  readonly eventIdentifier: string
  readonly imageNetClass: SmartVisionImageNetClass
  readonly objectIdentifier?: string
  readonly frameImageUri?: string
  readonly croppedImageUri?: string
}

export function buildSmartVisionObjectDetectionEvent(opts: {
  userId: string
  endpointId: string
  detections: readonly SmartVisionDetection[]
  timestamp: number
  accessToken: string
}): SmartVisionObjectDetectionEvent {
  const timeOfSample = new Date(opts.timestamp).toISOString()
  return {
    event: {
      header: {
        namespace: 'Alexa.SmartVision.ObjectDetectionSensor',
        name: 'ObjectDetection',
        messageId: randomUUID(),
        payloadVersion: '1.0',
      },
      endpoint: {
        scope: { type: 'BearerToken', token: opts.accessToken },
        endpointId: opts.endpointId,
      },
      payload: {
        events: opts.detections.map((d) => ({
          eventIdentifier: d.eventIdentifier,
          imageNetClass: d.imageNetClass,
          timeOfSample,
          uncertaintyInMilliseconds: 500,
          ...(d.objectIdentifier !== undefined ? { objectIdentifier: d.objectIdentifier } : {}),
          ...(d.frameImageUri !== undefined ? { frameImageUri: d.frameImageUri } : {}),
          ...(d.croppedImageUri !== undefined ? { croppedImageUri: d.croppedImageUri } : {}),
        })),
      },
    },
  }
}

/** Every `sig=` query value in a URI, for a log line. */
function redactSignature(uri: string | undefined): string | undefined {
  return uri?.replace(/([?&]sig=)[^&]*/g, '$1<redacted>')
}

/**
 * The ObjectDetection body exactly as built for the wire, minus its secrets
 * (D779 amendment): the scope token and every image URI's signature. Logged once per
 * endpoint per process so the shape can be compared with Amazon's example.
 */
export function redactedObjectDetectionSample(
  opts: Parameters<typeof buildSmartVisionObjectDetectionEvent>[0],
): SmartVisionObjectDetectionEvent {
  const body = buildSmartVisionObjectDetectionEvent({ ...opts, accessToken: '<redacted>' })
  return {
    event: {
      ...body.event,
      payload: {
        events: body.event.payload.events.map((e) => ({
          ...e,
          ...(e.frameImageUri !== undefined
            ? { frameImageUri: redactSignature(e.frameImageUri) }
            : {}),
          ...(e.croppedImageUri !== undefined
            ? { croppedImageUri: redactSignature(e.croppedImageUri) }
            : {}),
        })),
      },
    },
  }
}

// ── Discovery report payload builders (pure) ────────────────────────
//
// The Event Gateway authenticates via the `Authorization: Bearer` header
// (set by `postEventBody`), so `scope.token` carries the canonical
// placeholder like the doorbell/motion payloads — Amazon ignores its value.

interface AddOrUpdateReport {
  readonly event: {
    readonly header: {
      readonly namespace: 'Alexa.Discovery'
      readonly name: 'AddOrUpdateReport'
      readonly messageId: string
      readonly payloadVersion: '3'
    }
    readonly payload: {
      readonly endpoints: readonly AlexaEndpoint[]
      readonly scope: { readonly type: 'BearerToken'; readonly token: string }
    }
  }
}

export function buildAddOrUpdateReportPayload(
  _userId: string,
  endpoints: readonly AlexaEndpoint[],
  accessToken: string,
): AddOrUpdateReport {
  return {
    event: {
      header: {
        namespace: 'Alexa.Discovery',
        name: 'AddOrUpdateReport',
        messageId: randomUUID(),
        payloadVersion: '3',
      },
      payload: {
        endpoints,
        scope: { type: 'BearerToken', token: accessToken },
      },
    },
  }
}

interface DeleteReport {
  readonly event: {
    readonly header: {
      readonly namespace: 'Alexa.Discovery'
      readonly name: 'DeleteReport'
      readonly messageId: string
      readonly payloadVersion: '3'
    }
    readonly payload: {
      readonly endpoints: ReadonlyArray<{ readonly endpointId: string }>
      readonly scope: { readonly type: 'BearerToken'; readonly token: string }
    }
  }
}

export function buildDeleteReportPayload(
  _userId: string,
  endpointIds: readonly string[],
  accessToken: string,
): DeleteReport {
  return {
    event: {
      header: {
        namespace: 'Alexa.Discovery',
        name: 'DeleteReport',
        messageId: randomUUID(),
        payloadVersion: '3',
      },
      payload: {
        endpoints: endpointIds.map((endpointId) => ({ endpointId })),
        scope: { type: 'BearerToken', token: accessToken },
      },
    },
  }
}
