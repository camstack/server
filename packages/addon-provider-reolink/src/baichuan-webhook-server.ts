import {
  createBaichuanWebhookServer,
  mapBaichuanWebhookToSimpleEvents,
  onBaichuanWebhookEvent,
  type BaichuanWebhookEvent,
  type BaichuanWebhookServerInstance,
} from '@apocaliss92/nodelink-js'
import type { IScopedLogger } from '@camstack/types'
import { ReolinkCamera } from './reolink-camera.js'
import {
  DEFAULT_BAICHUAN_WEBHOOK_PATH_PREFIX,
  DEFAULT_BAICHUAN_WEBHOOK_PORT,
  buildBaichuanWebhookUrl,
  type BaichuanWebhookManagerSetupParams,
} from './baichuan-webhook-shared.js'
import { listLanHosts } from './email-push-shared.js'

/**
 * Manager-side HTTP intake for Reolink BATTERY HaCfg webhook push (cmd 807).
 *
 * Parallel to {@link ReolinkEmailPushServer}: one listener per Reolink addon
 * process. Cameras POST wake/sleep JSON to
 * `http://<lanHost>:<port>/webhook/<stableId>`; we map onto
 * `handleSimpleEvent` with `source: 'baichuanWebhook'`.
 *
 * Uses a dedicated HTTP port (not the hub HTTPS data-plane): HaCfg firmwares
 * commonly refuse the hub's self-signed cert even with verifyCert=false on
 * some builds, and the lib's intake is designed for a plain LAN bind.
 */

export interface BaichuanWebhookSettings {
  readonly enabled: boolean
  readonly port: number
  readonly bindHost: string
}

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

export interface BaichuanWebhookServerDeps {
  readonly logger: IScopedLogger
  readonly listCameras: () => readonly ReolinkCamera[]
  readonly readStore: () => Promise<Record<string, unknown>>
}

export class ReolinkBaichuanWebhookServer {
  private instance: BaichuanWebhookServerInstance | undefined
  private busOff: (() => void) | undefined
  private settings: BaichuanWebhookSettings | undefined

  constructor(private readonly deps: BaichuanWebhookServerDeps) {}

  private async resolveSettings(): Promise<BaichuanWebhookSettings> {
    if (this.settings) return this.settings
    const raw = await this.deps.readStore()
    this.settings = {
      enabled: readBoolean(raw, 'baichuanWebhookEnabled', true),
      port: readNumber(raw, 'baichuanWebhookPort', DEFAULT_BAICHUAN_WEBHOOK_PORT),
      bindHost: readString(raw, 'baichuanWebhookBindHost', '0.0.0.0'),
    }
    return this.settings
  }

  /** Drop the cached settings so the next start re-reads the store. */
  reloadSettings(): void {
    this.settings = undefined
  }

  private findCameraByStableId(stableId: string): ReolinkCamera | undefined {
    return this.deps.listCameras().find((c) => c.stableId === stableId)
  }

  private resolveCameraId(pathId: string): string | undefined {
    const cam = this.findCameraByStableId(pathId)
    if (!cam || !cam.isEmailPushEligible) return undefined
    return pathId
  }

  private dispatchEvent(event: BaichuanWebhookEvent): void {
    const cam = this.findCameraByStableId(event.cameraId)
    if (!cam) {
      this.deps.logger.warn('baichuan-webhook: event for unknown camera id — dropping', {
        meta: { cameraId: event.cameraId, event: event.event },
      })
      return
    }
    const types = mapBaichuanWebhookToSimpleEvents({
      event: event.event,
      reason: event.reason,
    })
    this.deps.logger.info('baichuan-webhook: event received from battery camera', {
      tags: { deviceId: cam.id },
      meta: {
        event: event.event,
        reason: event.reason,
        types,
      },
    })
    const timestamp = Date.now()
    const channel = cam.emailPushChannel
    for (const type of types) {
      cam.handleSimpleEvent({
        type,
        channel,
        timestamp,
        source: 'baichuanWebhook',
      })
    }
  }

  async start(): Promise<void> {
    const settings = await this.resolveSettings()
    if (!settings.enabled) {
      this.deps.logger.debug('baichuan-webhook: disabled — HTTP intake not started')
      return
    }
    if (this.instance) {
      this.instance.updateConfig({
        port: settings.port,
        bindHost: settings.bindHost,
        pathPrefix: DEFAULT_BAICHUAN_WEBHOOK_PATH_PREFIX,
      })
      return
    }

    this.instance = createBaichuanWebhookServer({
      config: {
        port: settings.port,
        bindHost: settings.bindHost,
        pathPrefix: DEFAULT_BAICHUAN_WEBHOOK_PATH_PREFIX,
      },
      cameraResolver: (pathId: string) => this.resolveCameraId(pathId),
      enabled: true,
      logger: {
        debug: (m: string) => this.deps.logger.debug(`[hacfg] ${m}`),
        info: (m: string) => this.deps.logger.info(`[hacfg] ${m}`),
        warn: (m: string) => this.deps.logger.warn(`[hacfg] ${m}`),
        error: (m: string) => this.deps.logger.error(`[hacfg] ${m}`),
      },
    })

    this.busOff = onBaichuanWebhookEvent((event: BaichuanWebhookEvent) => this.dispatchEvent(event))

    try {
      await this.instance.start()
      this.deps.logger.info('baichuan-webhook: HTTP intake listening', {
        meta: {
          host: settings.bindHost,
          port: settings.port,
          pathPrefix: DEFAULT_BAICHUAN_WEBHOOK_PATH_PREFIX,
        },
      })
    } catch (err) {
      this.deps.logger.error('baichuan-webhook: HTTP intake failed to start', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      this.busOff?.()
      this.busOff = undefined
      this.instance = undefined
    }
  }

  async restart(): Promise<void> {
    await this.stop()
    this.reloadSettings()
    await this.start()
  }

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
   * Absolute HaCfg URL for one camera, or null when the intake is off /
   * has no LAN host / the camera is ineligible.
   */
  async buildCameraSetupParams(
    cam: ReolinkCamera,
  ): Promise<BaichuanWebhookManagerSetupParams | null> {
    if (!cam.isEmailPushEligible) return null
    const settings = await this.resolveSettings()
    if (!settings.enabled) return null
    const managerHost = listLanHosts()[0]
    if (!managerHost) return null
    return {
      url: buildBaichuanWebhookUrl({
        host: managerHost,
        port: settings.port,
        cameraId: cam.stableId,
      }),
      verifyCert: false,
    }
  }
}
