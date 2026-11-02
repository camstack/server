/**
 * Leaf constants + helpers for Baichuan HaCfg webhook (battery sleep push).
 *
 * Dependency-free so the webhook plane and per-camera
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

/** The data-plane prefix this addon serves the camera push on: `/addon/<addonId>/webhook/<stableId>`. */
export const BAICHUAN_WEBHOOK_PREFIX = 'webhook'

/** The addon id the hub's reverse proxy mounts the plane under. */
export const BAICHUAN_WEBHOOK_ADDON_ID = 'provider-reolink'

/** The hub's plain-HTTP LAN listener, when the address book does not say (a hub older than its `listenerOrigins`). */
export const DEFAULT_LAN_HTTP_PORT = 4480

/**
 * The URL generation a camera is pointed at. Absent = the retired private listener
 * (`:9081/webhook/<id>`); 1 = this data-plane URL. A camera whose stored generation is lower is
 * re-pointed once, on its first Baichuan contact after the upgrade.
 */
export const BAICHUAN_WEBHOOK_URL_GENERATION = 1

/**
 * Absolute URL a camera should POST HaCfg events to: the addon's data plane on the hub's plain-HTTP
 * LAN listener. HTTP, not HTTPS: the firmware refuses the hub's self-signed certificate.
 */
export function buildBaichuanWebhookUrl(params: {
  readonly host: string
  readonly port: number
  readonly stableId: string
}): string {
  const id = encodeURIComponent(params.stableId)
  return `http://${params.host}:${String(params.port)}/addon/${BAICHUAN_WEBHOOK_ADDON_ID}/${BAICHUAN_WEBHOOK_PREFIX}/${id}`
}

/** The slice of the local-network address book the webhook endpoint is derived from. */
export interface WebhookAddressBook {
  readonly roles: { readonly internal: { readonly resolved: string | null } }
  readonly listenerOrigins?: readonly string[] | undefined
}

/** Where a camera reaches the hub's plain-HTTP listener. */
export interface WebhookEndpoint {
  readonly host: string
  readonly port: number
}

function hostOf(url: string | null): string | null {
  if (url === null || url.trim().length === 0) return null
  try {
    const host = new URL(url).hostname
    return host.length > 0 ? host : null
  } catch {
    return null
  }
}

/**
 * The host is the `internal` role of the palette (D729) and the port is the plain-HTTP origin the
 * hub lists for that host. Throws the reason, in the operator's words, when there is none: there is
 * no fallback host and never an HTTPS one.
 */
export function resolveWebhookEndpoint(book: WebhookAddressBook): WebhookEndpoint {
  const host = hostOf(book.roles.internal.resolved)
  if (host === null) throw new Error('The hub has no internal address (System → Network)')
  if (book.listenerOrigins === undefined) return { host, port: DEFAULT_LAN_HTTP_PORT }
  for (const origin of book.listenerOrigins) {
    try {
      const url = new URL(origin)
      if (url.protocol === 'http:' && url.hostname === host) {
        return { host, port: url.port.length > 0 ? Number(url.port) : 80 }
      }
    } catch {
      // not a URL: not an origin to use
    }
  }
  throw new Error(
    'The hub has no plain-HTTP LAN listener: the camera webhook cannot use HTTPS. Turn on LAN HTTP in System → Network',
  )
}

/**
 * Manager-side parameters a camera needs to arm HaCfg at this intake.
 */
export interface BaichuanWebhookManagerSetupParams {
  readonly url: string
  readonly verifyCert: boolean
}

export type BaichuanWebhookParamsResolver = () => Promise<BaichuanWebhookManagerSetupParams | null>
