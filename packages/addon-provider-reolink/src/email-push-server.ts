import { randomBytes } from 'node:crypto'
import {
  createEmailPushServer,
  type EmailPushEvent,
  type EmailPushServerConfig,
  type EmailPushServerInstance,
  onEmailPushEvent,
} from '@apocaliss92/nodelink-js'
import type { IScopedLogger } from '@camstack/types'
import { isSecretMarkerLike } from '@camstack/types'
import {
  DEFAULT_EMAIL_PUSH_DOMAIN,
  DEFAULT_EMAIL_PUSH_MAX_MESSAGE_BYTES,
  DEFAULT_EMAIL_PUSH_PORT,
  type EmailPushManagerSetupParams,
  listLanHosts,
  mapInferredTypeToSimpleEvents,
} from './email-push-shared.js'
import { ReolinkCamera } from './reolink-camera.js'

/**
 * Manager-side SMTP intake for Reolink BATTERY cameras.
 *
 * Battery Reolink cams sleep + are unreachable over Baichuan most of the
 * time; on motion they wake and (when configured) connect to an SMTP
 * server to send an email + snapshot. Emulating that SMTP server locally
 * lets us observe motion from battery cams WITHOUT polling them awake.
 *
 * This is a provider-level singleton (one SMTP server per Reolink addon
 * process). Inbound mail is routed to the right `ReolinkCamera` by the
 * RCPT TO local-part: the camera is configured (via
 * `api.setupEmailPushToManager`) to send to `cam-<stableId>@<domain>`,
 * and `resolveCameraId` matches `<stableId>` against this addon's live
 * devices.
 *
 * Each accepted email is classified by the lib (`motion`/`people`/…) and
 * fed into the matched camera's `handleSimpleEvent` — the SAME unified
 * entry that handles native Baichuan push — so SMTP motion flows through
 * `EventCategory.ProviderMotion` / `DetectionCameraNative` exactly
 * like onboard motion. We subscribe on the module-level email-push bus
 * (`onEmailPushEvent`) rather than per-camera api bridges so delivery is
 * independent of the (possibly torn-down) battery cam's Baichuan socket.
 */

/**
 * Persisted addon-store shape for the email-push server. All fields are
 * optional in the raw store (hydrated with the defaults below); the
 * `authUsername` / `authPassword` are bootstrapped with random values on
 * first read so the operator never runs an open relay by accident.
 */
export interface EmailPushSettings {
  readonly enabled: boolean
  readonly port: number
  readonly bindHost: string
  readonly domain: string
  readonly requireAuth: boolean
  readonly authUsername: string
  readonly authPassword: string
  readonly maxMessageBytes: number
}

/** Reads a typed value from the raw addon store with a fallback. */
function readString(raw: Record<string, unknown>, key: string, fallback: string): string {
  const v = raw[key]
  return typeof v === 'string' && v.length > 0 ? v : fallback
}

function readNumber(raw: Record<string, unknown>, key: string, fallback: number): number {
  const v = raw[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function readBoolean(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = raw[key]
  return typeof v === 'boolean' ? v : fallback
}

/** Dependencies the server needs from the owning provider. Kept as a
 *  narrow interface so the module never reaches back into the provider
 *  class directly. */
export interface EmailPushServerDeps {
  readonly logger: IScopedLogger
  /** Snapshot of this addon's live Reolink cameras. */
  readonly listCameras: () => readonly ReolinkCamera[]
  /** Addon-store snapshot reader (persisted settings). */
  readonly readStore: () => Promise<Record<string, unknown>>
  /** Persists the bootstrapped SMTP AUTH credentials. The server writes
   *  ONLY the `emailPushAuthUsername` / `emailPushAuthPassword` string
   *  keys through this — never arbitrary settings. */
  readonly writeStore: (patch: Record<string, unknown>) => Promise<void>
}

/**
 * Owns the lib's SMTP intake for the Reolink addon. Lifecycle:
 *   - `start()` from the provider's `onInitialize` (no-op when disabled).
 *   - `restart()` from `onConfigChanged` so port/domain/auth edits apply.
 *   - `stop()` from the provider's `onShutdown`.
 */
export class ReolinkEmailPushServer {
  private instance: EmailPushServerInstance | undefined
  private busOff: (() => void) | undefined
  private settings: EmailPushSettings | undefined

  constructor(private readonly deps: EmailPushServerDeps) {}

  /**
   * Hydrate the persisted settings, bootstrapping random AUTH
   * credentials on first use so the server is never an open relay.
   * Cached after the first resolution; `reloadSettings` forces a re-read.
   */
  private async resolveSettings(): Promise<EmailPushSettings> {
    if (this.settings) return this.settings
    const raw = await this.deps.readStore()

    let authUsername = readString(raw, 'emailPushAuthUsername', '')
    let authPassword = readString(raw, 'emailPushAuthPassword', '')
    // A keychain marker still here means the password IS stored but could not
    // be resolved. Bootstrapping over it would replace the password the
    // cameras were provisioned with — and the write is a config change that
    // restarts this server into the same read, a loop (D787).
    const passwordUnresolved = isSecretMarkerLike(raw['emailPushAuthPassword'])
    const bootstrapped: Record<string, unknown> = {}
    if (!authUsername) {
      authUsername = `camstack-${randomBytes(4).toString('hex')}`
      bootstrapped.emailPushAuthUsername = authUsername
    }
    if (!authPassword) {
      authPassword = randomBytes(18).toString('base64url')
      if (passwordUnresolved) {
        this.deps.logger.error(
          'email-push: the SMTP password is in the keychain but could not be read — ' +
            'running on a temporary password that is NOT saved; camera mail will fail AUTH until it resolves',
        )
      } else {
        bootstrapped.emailPushAuthPassword = authPassword
      }
    }
    if (Object.keys(bootstrapped).length > 0) {
      // Best-effort persist — if the write fails the in-memory creds
      // still work for this process lifetime; the next boot re-bootstraps.
      try {
        await this.deps.writeStore(bootstrapped)
      } catch (err) {
        this.deps.logger.warn('email-push: failed to persist bootstrapped credentials', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }

    this.settings = {
      // Enabled by default: the SMTP intake is the only way to capture motion
      // from sleeping battery cameras, so it should be on out of the box. The
      // operator can still disable it explicitly via the settings toggle.
      enabled: readBoolean(raw, 'emailPushEnabled', true),
      port: readNumber(raw, 'emailPushPort', DEFAULT_EMAIL_PUSH_PORT),
      bindHost: readString(raw, 'emailPushBindHost', '0.0.0.0'),
      domain: readString(raw, 'emailPushDomain', DEFAULT_EMAIL_PUSH_DOMAIN),
      requireAuth: readBoolean(raw, 'emailPushRequireAuth', true),
      authUsername,
      authPassword,
      maxMessageBytes: readNumber(
        raw,
        'emailPushMaxMessageBytes',
        DEFAULT_EMAIL_PUSH_MAX_MESSAGE_BYTES,
      ),
    }
    return this.settings
  }

  /** Drop the cached settings so the next start/restart re-reads the
   *  store (used by `restart`). */
  private reloadSettings(): void {
    this.settings = undefined
  }

  private buildConfig(settings: EmailPushSettings): EmailPushServerConfig {
    return {
      port: settings.port,
      bindHost: settings.bindHost,
      domain: settings.domain,
      requireAuth: settings.requireAuth,
      authUsername: settings.authUsername,
      authPassword: settings.authPassword,
      tls: false,
      maxMessageBytes: settings.maxMessageBytes,
    }
  }

  /**
   * Resolve a recipient local-part (`<id>`, already stripped of the
   * `cam-` prefix by the lib) to a camera id. Returns the matching
   * camera's `stableId` (which the lib echoes back as `event.cameraId`)
   * or `undefined` to reject the recipient at RCPT TO.
   *
   * Hub-attached children are skipped: they share the parent's TCP
   * socket and have no independent email path, so accepting one would
   * silently mis-route. Match is on `stableId` (durable across
   * re-adoption) — the same value `buildCameraSetupParams` writes into
   * the camera's email config.
   */
  private resolveCameraId(localPart: string): string | undefined {
    const cam = this.findCameraByStableId(localPart)
    if (!cam || !cam.isEmailPushEligible) return undefined
    return localPart
  }

  private findCameraByStableId(stableId: string): ReolinkCamera | undefined {
    return this.deps.listCameras().find((c) => c.stableId === stableId)
  }

  /** Route an accepted email-push event into the matched camera's unified
   *  simple-event handler. */
  private dispatchEvent(event: EmailPushEvent): void {
    const cam = this.findCameraByStableId(event.cameraId)
    if (!cam) {
      this.deps.logger.warn('email-push: event for unknown camera id — dropping', {
        meta: { cameraId: event.cameraId, inferredType: event.inferredType },
      })
      return
    }
    this.deps.logger.info('email-push: motion received from battery camera', {
      tags: { deviceId: cam.id },
      meta: { inferredType: event.inferredType, subject: event.subject.slice(0, 80) },
    })
    // One email can owe the camera more than one simple event — see
    // `mapInferredTypeToSimpleEvents` for why `doorbell` alone would be a
    // dropped wake.
    for (const type of mapInferredTypeToSimpleEvents(event.inferredType)) {
      cam.handleSimpleEvent({
        type,
        channel: cam.emailPushChannel,
        timestamp: event.receivedAtMs,
        source: 'email',
      })
    }
  }

  /** Start the SMTP intake when enabled. Idempotent: a second call while
   *  running re-applies config without rebinding. */
  async start(): Promise<void> {
    const settings = await this.resolveSettings()
    if (!settings.enabled) {
      this.deps.logger.debug('email-push: disabled — SMTP intake not started')
      return
    }
    if (this.instance) {
      this.instance.updateConfig(this.buildConfig(settings))
      return
    }

    this.instance = createEmailPushServer({
      config: this.buildConfig(settings),
      cameraResolver: (local: string) => this.resolveCameraId(local),
      logger: {
        debug: (m: string) => this.deps.logger.debug(`[smtp] ${m}`),
        info: (m: string) => this.deps.logger.info(`[smtp] ${m}`),
        warn: (m: string) => this.deps.logger.warn(`[smtp] ${m}`),
        error: (m: string) => this.deps.logger.error(`[smtp] ${m}`),
      },
    })

    // Subscribe on the module-level bus (NOT per-camera api bridges) so
    // delivery survives a battery cam whose Baichuan socket is torn down.
    this.busOff = onEmailPushEvent((event: EmailPushEvent) => this.dispatchEvent(event))

    try {
      await this.instance.start()
      this.deps.logger.info('email-push: SMTP intake listening', {
        meta: {
          host: settings.bindHost,
          port: settings.port,
          domain: settings.domain,
          requireAuth: settings.requireAuth,
        },
      })
    } catch (err) {
      this.deps.logger.error('email-push: SMTP intake failed to start', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      // Roll back so a later restart can retry cleanly.
      this.busOff?.()
      this.busOff = undefined
      this.instance = undefined
    }
  }

  /** Re-read settings and rebind. Used after a settings edit. */
  async restart(): Promise<void> {
    await this.stop()
    this.reloadSettings()
    await this.start()
  }

  /** Stop the SMTP intake + detach the bus subscription. Safe to call
   *  when never started. */
  async stop(): Promise<void> {
    this.busOff?.()
    this.busOff = undefined
    if (this.instance) {
      await this.instance.stop().catch(() => {
        /* best-effort */
      })
      this.instance = undefined
    }
  }

  /**
   * Compute the manager-side parameters a given camera needs to send
   * email-push to this server. Returns `null` when the server has no
   * resolvable LAN address (no camera-reachable host), or the camera is
   * hub-attached / not eligible. The caller passes these straight into
   * `api.setupEmailPushToManager`.
   */
  async buildCameraSetupParams(cam: ReolinkCamera): Promise<EmailPushManagerSetupParams | null> {
    if (!cam.isEmailPushEligible) return null
    const settings = await this.resolveSettings()
    const managerHost = listLanHosts()[0]
    if (!managerHost) return null
    return {
      managerHost,
      managerPort: settings.port,
      domain: settings.domain,
      // The `cam-` prefix is mandatory: the lib matches RCPT local-parts
      // against `^cam-(.+)$` and feeds the captured group to
      // `cameraResolver`. Without it every delivery is rejected with
      // "550 Unknown recipient".
      recipientLocalPart: `cam-${cam.stableId}`,
      ...(settings.requireAuth
        ? { authUsername: settings.authUsername, authPassword: settings.authPassword }
        : {}),
    }
  }
}
