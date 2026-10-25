/**
 * Leaf constants + helpers for Baichuan HaCfg webhook (battery sleep push).
 *
 * Dependency-free so the intake server, settings schema and per-camera
 * Auto-configure can share them without an import cycle.
 */

/** User preference for sleep-time motion/doorbell delivery. */
export type BatterySleepPushMethod = 'auto' | 'webhook' | 'email'

/** Effective single path after resolving preference + HaCfg probe. */
export type BatterySleepPushEffective = 'webhook' | 'email'

/**
 * Resolve which sleep-push path to arm. Only one path should be active so
 * HaCfg HTTP and SMTP do not both fire into `handleSimpleEvent`.
 *
 * - `email` → always e-mail
 * - `webhook` → always HaCfg (caller must handle unsupported firmware)
 * - `auto` (default) → HaCfg when probe says supported, else e-mail
 */
export function resolveBatterySleepPushMethod(
  preference: BatterySleepPushMethod | string | undefined,
  webhookSupported: boolean,
): BatterySleepPushEffective {
  if (preference === 'email') return 'email'
  if (preference === 'webhook') return 'webhook'
  return webhookSupported ? 'webhook' : 'email'
}

/** Default HTTP listen port for HaCfg POSTs (matches nodelink docs / HA). */
export const DEFAULT_BAICHUAN_WEBHOOK_PORT = 9081

/** Path prefix before the camera id. Final route: `${prefix}/:cameraId`. */
export const DEFAULT_BAICHUAN_WEBHOOK_PATH_PREFIX = '/webhook'

/**
 * Absolute URL a camera should POST HaCfg events to.
 * HTTP (not HTTPS): Reolink HaCfg often fails TLS verify against the hub's
 * self-signed cert; the intake binds a dedicated LAN port like SMTP.
 */
export function buildBaichuanWebhookUrl(params: {
  readonly host: string
  readonly port: number
  readonly cameraId: string
  readonly pathPrefix?: string
}): string {
  const prefix = (params.pathPrefix ?? DEFAULT_BAICHUAN_WEBHOOK_PATH_PREFIX).replace(/\/$/, '')
  const id = encodeURIComponent(params.cameraId)
  return `http://${params.host}:${String(params.port)}${prefix}/${id}`
}

/**
 * Manager-side parameters a camera needs to arm HaCfg at this intake.
 */
export interface BaichuanWebhookManagerSetupParams {
  readonly url: string
  readonly verifyCert: boolean
}

export type BaichuanWebhookParamsResolver = () => Promise<BaichuanWebhookManagerSetupParams | null>
