/**
 * WhatsApp notifier adapter — Green API only.
 *
 * WhatsApp has NO free official notification API. Delivery drives a real
 * WhatsApp account through Green API's HTTP wrapper, which is against Meta's
 * ToS and carries a number-ban risk. Gated behind `acknowledgeToS`.
 *
 * Host selection (`apiHostMode`):
 *   - universal (default) → https://api.greenapi.com  (works across partitions)
 *   - auto → https://{first-4-digits-of-idInstance}.api.greenapi.com
 *   - 7103 / 7105 → dedicated cluster hosts (7105 from operator reports where
 *     a hardcoded 7103 host returned 403)
 *   - custom → operator-supplied `apiUrl`
 *
 * Credential model: idInstance + apiTokenInstance live in the URL path.
 *   sendMessage:     POST {apiUrl}/waInstance{id}/sendMessage/{token}
 *   sendFileByUrl:   POST {apiUrl}/waInstance{id}/sendFileByUrl/{token}
 *   getStateInstance: GET {apiUrl}/waInstance{id}/getStateInstance/{token}
 *   getContacts:     GET {apiUrl}/waInstance{id}/getContacts/{token}
 *   getChats:        GET {apiUrl}/waInstance{id}/getChats/{token}
 */
import type {
  ConfigUISchema,
  DiscoveredTarget,
  PreparedAttachment,
  PreparedNotification,
} from '@camstack/types'
import { fetchWithTimeout } from '../http.js'
import type { HttpRequestPlan, HttpNotifierAdapter, ProbeResult, TargetConfig } from './adapter.js'

/** Host mode persisted on the target config. Default is the universal host. */
export type GreenApiHostMode = 'universal' | 'auto' | '7103' | '7105' | 'custom'

const GREEN_API_HOST_SUFFIX = 'api.greenapi.com'
const GREEN_MEDIA_HOST_SUFFIX = 'media.greenapi.com'
export const GREEN_API_UNIVERSAL_URL = 'https://api.greenapi.com'
export const GREEN_MEDIA_UNIVERSAL_URL = 'https://media.greenapi.com'

const PROBE_TIMEOUT_MS = 10_000

// ── Small pure helpers ──────────────────────────────────────────────

function requireString(config: TargetConfig, key: string): string {
  const value = config[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`whatsapp: missing required config field '${key}'`)
  }
  return value
}

function optionalString(config: TargetConfig, key: string, fallback: string): string {
  const value = config[key]
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

/** Strip trailing slashes so `${base}/path` never doubles up. */
function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * Resolve the host mode. Absent / unknown → schema default `universal`.
 * A leftover `apiUrl` on an old row is ignored unless `apiHostMode` is
 * `custom` — same rule as `fieldInUse` / `showWhen`, so a hidden field never
 * routes the secret.
 */
export function greenApiHostModeOf(config: TargetConfig): GreenApiHostMode {
  const raw = config['apiHostMode']
  if (
    raw === 'universal' ||
    raw === 'auto' ||
    raw === '7103' ||
    raw === '7105' ||
    raw === 'custom'
  ) {
    return raw
  }
  return 'universal'
}

/**
 * Resolve the Green API base URL from host mode + credentials.
 * Pure — used by `buildRequest` and `probe`.
 */
export function resolveGreenApiUrl(config: TargetConfig): string {
  const mode = greenApiHostModeOf(config)
  switch (mode) {
    case 'universal':
      return GREEN_API_UNIVERSAL_URL
    case '7103':
      return `https://7103.${GREEN_API_HOST_SUFFIX}`
    case '7105':
      return `https://7105.${GREEN_API_HOST_SUFFIX}`
    case 'auto': {
      const idInstance = requireString(config, 'idInstance')
      const partition = idInstance.match(/^(\d{4})/)?.[1]
      if (partition === undefined) {
        throw new Error(
          'whatsapp: apiHostMode=auto needs an Instance ID whose first four characters are digits',
        )
      }
      return `https://${partition}.${GREEN_API_HOST_SUFFIX}`
    }
    case 'custom':
      return trimSlash(requireString(config, 'apiUrl'))
  }
}

/** Optional media host; mirrors the API host partition when unset. */
export function resolveGreenMediaUrl(config: TargetConfig): string | undefined {
  const explicit = optionalString(config, 'mediaUrl', '')
  if (explicit.length > 0) return trimSlash(explicit)
  const mode = greenApiHostModeOf(config)
  switch (mode) {
    case 'universal':
      return GREEN_MEDIA_UNIVERSAL_URL
    case '7103':
      return `https://7103.${GREEN_MEDIA_HOST_SUFFIX}`
    case '7105':
      return `https://7105.${GREEN_MEDIA_HOST_SUFFIX}`
    case 'auto': {
      const idInstance = optionalString(config, 'idInstance', '')
      const partition = idInstance.match(/^(\d{4})/)?.[1]
      if (partition === undefined) return undefined
      return `https://${partition}.${GREEN_MEDIA_HOST_SUFFIX}`
    }
    case 'custom':
      return undefined
  }
}

/**
 * `chatId` holds the recipient in intl format without `+` (e.g. `39333…`) or a
 * full WhatsApp id (`…@c.us` / `…@g.us`). Append `@c.us` when no `@` is present.
 */
function chatIdFor(config: TargetConfig): string {
  const raw = requireString(config, 'chatId')
  return raw.includes('@') ? raw : `${raw}@c.us`
}

/**
 * WhatsApp-flavored text: bold title (`*title*`) as the first line, then body,
 * then the click-through URL on its own line so WhatsApp renders a preview.
 */
function composeText(prepared: PreparedNotification): string {
  const lines: string[] = []
  if (prepared.title !== undefined && prepared.title.length > 0) {
    lines.push(`*${prepared.title}*`)
  }
  lines.push(prepared.body)
  if (prepared.clickUrl !== null && prepared.clickUrl.length > 0) {
    lines.push(prepared.clickUrl)
  }
  return lines.join('\n')
}

interface UrlMedia {
  readonly att: PreparedAttachment
  readonly url: string
}

/** First attachment that carries a URL (caps: mode 'url', max 1). */
function firstUrlMedia(prepared: PreparedNotification): UrlMedia | null {
  for (const att of prepared.attachments) {
    if (typeof att.url === 'string' && att.url.length > 0) return { att, url: att.url }
  }
  return null
}

function fileNameFor(att: PreparedAttachment): string {
  if (att.name !== undefined && att.name.length > 0) return att.name
  if (att.url !== undefined) {
    const clean = att.url.split('?')[0] ?? att.url
    const seg = clean.slice(clean.lastIndexOf('/') + 1)
    if (seg.length > 0) return seg
  }
  return 'attachment'
}

function buildGreenApi(
  config: TargetConfig,
  text: string,
  media: UrlMedia | null,
): HttpRequestPlan {
  const idInstance = requireString(config, 'idInstance')
  const apiUrl = resolveGreenApiUrl(config)
  const apiTokenInstance = requireString(config, 'apiTokenInstance')
  const chatId = chatIdFor(config)

  if (media !== null) {
    return {
      url: `${apiUrl}/waInstance${idInstance}/sendFileByUrl/${apiTokenInstance}`,
      method: 'POST',
      body: {
        kind: 'json',
        value: { chatId, urlFile: media.url, fileName: fileNameFor(media.att), caption: text },
      },
    }
  }
  return {
    url: `${apiUrl}/waInstance${idInstance}/sendMessage/${apiTokenInstance}`,
    method: 'POST',
    body: { kind: 'json', value: { chatId, message: text } },
  }
}

/**
 * Probe credentials with `getStateInstance`. Returns a token-free `resolvedUrl`
 * (host + path up to the method name) so the UI can show which host was dialled.
 */
export async function probeGreenApi(config: TargetConfig): Promise<ProbeResult> {
  let apiUrl: string
  let idInstance: string
  try {
    apiUrl = resolveGreenApiUrl(config)
    idInstance = requireString(config, 'idInstance')
  } catch (err) {
    return {
      ok: false,
      resolvedUrl: '',
      error: err instanceof Error ? err.message : String(err),
    }
  }
  const token = config['apiTokenInstance']
  if (typeof token !== 'string' || token.length === 0) {
    return {
      ok: false,
      resolvedUrl: `${apiUrl}/waInstance${idInstance}/getStateInstance`,
      error: "whatsapp: missing required config field 'apiTokenInstance'",
    }
  }
  const resolvedUrl = `${apiUrl}/waInstance${idInstance}/getStateInstance`
  const url = `${resolvedUrl}/${token}`
  try {
    const res = await fetchWithTimeout(url, { method: 'GET' }, PROBE_TIMEOUT_MS)
    const bodyText = await res.text()
    let stateInstance: string | undefined
    try {
      const parsed: unknown = JSON.parse(bodyText)
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as { stateInstance?: unknown }).stateInstance === 'string'
      ) {
        stateInstance = (parsed as { stateInstance: string }).stateInstance
      }
    } catch {
      // non-JSON body — still report http status
    }
    if (!res.ok) {
      return {
        ok: false,
        httpStatus: res.status,
        stateInstance,
        resolvedUrl,
        error: `HTTP ${res.status}${stateInstance !== undefined ? ` (${stateInstance})` : ''}`,
      }
    }
    // HTTP 200 alone is not success — Green API returns 200 with
    // `stateInstance: "notAuthorized"` until the operator scans the QR.
    // Only `authorized` can send / load contacts.
    if (stateInstance !== 'authorized') {
      return {
        ok: false,
        httpStatus: res.status,
        stateInstance,
        resolvedUrl,
        error:
          stateInstance === 'notAuthorized'
            ? 'Instance notAuthorized — scan the QR in the Green API console'
            : stateInstance !== undefined
              ? `Instance state is "${stateInstance}" (need "authorized")`
              : 'getStateInstance returned no stateInstance',
      }
    }
    return {
      ok: true,
      httpStatus: res.status,
      stateInstance,
      resolvedUrl,
    }
  } catch (err) {
    return {
      ok: false,
      resolvedUrl,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Pure parse of a Green API contact/chat list into discover candidates.
 * Accepts the shapes returned by `getContacts` and `getChats` (id + name).
 */
export function parseGreenApiContactRows(rows: unknown): readonly DiscoveredTarget[] {
  if (!Array.isArray(rows)) return []
  const seen = new Map<string, DiscoveredTarget>()
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const rec = row as { id?: unknown; name?: unknown; contactName?: unknown }
    if (typeof rec.id !== 'string' || rec.id.length === 0) continue
    if (seen.has(rec.id)) continue
    const name =
      (typeof rec.name === 'string' && rec.name.length > 0 ? rec.name : undefined) ??
      (typeof rec.contactName === 'string' && rec.contactName.length > 0
        ? rec.contactName
        : undefined) ??
      rec.id
    seen.set(rec.id, {
      kind: 'whatsapp',
      suggestedName: name,
      // Full WhatsApp id (`…@c.us` / `…@g.us`) — buildRequest accepts it as-is.
      config: { chatId: rec.id },
    })
  }
  return [...seen.values()]
}

async function fetchGreenApiJsonList(
  apiUrl: string,
  idInstance: string,
  token: string,
  method: 'getContacts' | 'getChats',
): Promise<unknown> {
  const url = `${apiUrl}/waInstance${idInstance}/${method}/${token}`
  const res = await fetchWithTimeout(url, { method: 'GET' }, PROBE_TIMEOUT_MS)
  const bodyText = await res.text()
  if (!res.ok) {
    throw new Error(`whatsapp: ${method} failed — HTTP ${res.status}`)
  }
  try {
    return JSON.parse(bodyText) as unknown
  } catch {
    throw new Error(`whatsapp: ${method} returned non-JSON`)
  }
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Load contacts + chats for the Discover picker. Requires a live, authorized
 * instance — `notAuthorized` fails with a clear message rather than an empty list.
 */
export async function discoverGreenApi(config: TargetConfig): Promise<readonly DiscoveredTarget[]> {
  // Without credentials there is nothing to search: answer empty, not an error.
  if (!hasText(config['idInstance']) || !hasText(config['apiTokenInstance'])) return []
  const apiUrl = resolveGreenApiUrl(config)
  const idInstance = requireString(config, 'idInstance')
  const token = requireString(config, 'apiTokenInstance')

  const probe = await probeGreenApi(config)
  if (!probe.ok) {
    throw new Error(
      probe.error !== undefined
        ? `whatsapp: ${probe.error}`
        : 'whatsapp: connection probe failed before loading contacts',
    )
  }

  const [contacts, chats] = await Promise.all([
    fetchGreenApiJsonList(apiUrl, idInstance, token, 'getContacts'),
    fetchGreenApiJsonList(apiUrl, idInstance, token, 'getChats').catch(() => []),
  ])
  // Contacts first; chats fill gaps (groups often appear only in getChats).
  const merged = new Map<string, DiscoveredTarget>()
  for (const hit of parseGreenApiContactRows(contacts)) {
    const id = hit.config['chatId']
    if (typeof id === 'string') merged.set(id, hit)
  }
  for (const hit of parseGreenApiContactRows(chats)) {
    const id = hit.config['chatId']
    if (typeof id === 'string' && !merged.has(id)) merged.set(id, hit)
  }
  return [...merged.values()]
}

// ── Config schema ───────────────────────────────────────────────────

function configSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'whatsapp',
        title: 'WhatsApp / Green API',
        titleKey: 'notifiers:config.s_whatsapp.title',
        description:
          'Delivers via Green API. Against Meta ToS — use a dedicated number; the account can be banned.',
        descriptionKey: 'notifiers:config.s_whatsapp.description',
        fields: [
          {
            type: 'info',
            key: 'tosWarning',
            label: 'Experimental — read before enabling',
            labelKey: 'notifiers:config.s_whatsapp.tosWarning.label',
            variant: 'warning',
            content:
              'WhatsApp has no free official notification API. This drives a real WhatsApp account through Green API, which violates WhatsApp Terms of Service and risks a permanent number ban. Use a dedicated number you can afford to lose.',
          },
          {
            type: 'select',
            key: 'apiHostMode',
            label: 'API host',
            labelKey: 'notifiers:config.s_whatsapp.apiHostMode.label',
            default: 'universal',
            immediate: true,
            options: [
              {
                value: 'universal',
                label: 'Universal (api.greenapi.com) — default',
                labelKey: 'notifiers:config.s_whatsapp.apiHostMode.o_universal.label',
              },
              {
                value: 'auto',
                label: 'Auto from Instance ID (first 4 digits)',
                labelKey: 'notifiers:config.s_whatsapp.apiHostMode.o_auto.label',
              },
              {
                value: '7103',
                label: 'Cluster 7103 (7103.api.greenapi.com)',
                labelKey: 'notifiers:config.s_whatsapp.apiHostMode.o_7103.label',
              },
              {
                value: '7105',
                label: 'Cluster 7105 (7105.api.greenapi.com)',
                labelKey: 'notifiers:config.s_whatsapp.apiHostMode.o_7105.label',
              },
              {
                value: 'custom',
                label: 'Custom URL',
                labelKey: 'notifiers:config.s_whatsapp.apiHostMode.o_custom.label',
              },
            ],
            description:
              'Universal works for most instances. Use a cluster host when the Green API console shows a dedicated apiUrl, or Custom to paste it verbatim.',
            descriptionKey: 'notifiers:config.s_whatsapp.apiHostMode.description',
          },
          {
            type: 'text',
            key: 'apiUrl',
            label: 'Custom API URL',
            labelKey: 'notifiers:config.s_whatsapp.apiUrl.label',
            required: true,
            placeholder: 'https://7103.api.greenapi.com',
            inputType: 'url',
            description: 'Copy apiUrl from your Green API console.',
            descriptionKey: 'notifiers:config.s_whatsapp.apiUrl.description',
            showWhen: { field: 'apiHostMode', equals: 'custom' },
          },
          {
            type: 'text',
            key: 'mediaUrl',
            label: 'Media URL (optional)',
            labelKey: 'notifiers:config.s_whatsapp.mediaUrl.label',
            placeholder: 'https://media.greenapi.com',
            inputType: 'url',
            description:
              'Optional media host from the console. Leave blank to mirror the API host. Not required for send-by-URL delivery.',
            descriptionKey: 'notifiers:config.s_whatsapp.mediaUrl.description',
          },
          {
            type: 'text',
            key: 'idInstance',
            label: 'Instance ID (idInstance)',
            labelKey: 'notifiers:config.s_whatsapp.idInstance.label',
            required: true,
          },
          {
            type: 'password',
            key: 'apiTokenInstance',
            label: 'API Token (apiTokenInstance)',
            labelKey: 'notifiers:config.s_whatsapp.apiTokenInstance.label',
            required: true,
          },
          {
            type: 'select',
            key: 'chatId',
            label: 'Chat ID / phone number',
            labelKey: 'notifiers:config.s_whatsapp.chatId.label',
            required: true,
            placeholder: '39333XXXXXXX',
            description:
              'Recipient in international format without "+", or a full WhatsApp id (…@c.us / …@g.us). Instance must be authorized in the Green API console.',
            descriptionKey: 'notifiers:config.s_whatsapp.chatId.description',
            options: [],
            discoverOptions: { kind: 'whatsapp', dependsOn: ['idInstance', 'apiTokenInstance'] },
          },
          {
            type: 'boolean',
            key: 'acknowledgeToS',
            label: 'I understand the ban risk and accept the WhatsApp Terms-of-Service violation',
            labelKey: 'notifiers:config.s_whatsapp.acknowledgeToS.label',
            required: true,
            style: 'checkbox',
            default: false,
          },
        ],
      },
    ],
  }
}

// ── Adapter ─────────────────────────────────────────────────────────

export const whatsappAdapter: HttpNotifierAdapter = {
  descriptor: {
    kind: 'whatsapp',
    label: 'WhatsApp / Green API',
    icon: 'message-circle',
    addonId: 'notifiers',
    configSchema: configSchema(),
    supportsDiscovery: true,
    caps: {
      attachments: { mediaTypes: ['image', 'video', 'audio'], mode: 'url', max: 1 },
      actions: 0,
      levels: [{ id: 'normal', label: 'Normal', ordinal: 3 }],
      format: ['text', 'markdown'],
      clickUrl: true,
      sound: false,
      ttl: false,
      bodyMaxLen: 4096,
    },
  },
  destinationKeys: ['apiHostMode', 'apiUrl', 'mediaUrl', 'idInstance', 'chatId'],

  buildRequest(config: TargetConfig, prepared: PreparedNotification): HttpRequestPlan {
    if (config.acknowledgeToS !== true) {
      throw new Error(
        'whatsapp: acknowledgeToS must be enabled — WhatsApp automation violates Meta ToS and risks a number ban',
      )
    }
    return buildGreenApi(config, composeText(prepared), firstUrlMedia(prepared))
  },

  probe: (config) => probeGreenApi(config),
  discover: (config) => discoverGreenApi(config),
}
